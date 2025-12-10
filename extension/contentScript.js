// contentScript.js

// Configuration - can be overridden via chrome.storage
const DEFAULT_CONFIG = {
  backendUrl: "http://localhost:8000",
  regretThreshold: 70,
  requestTimeout: 10000, // 10 seconds
  debounceDelay: 300, // ms to wait before checking
  enabled: true
};

let config = { ...DEFAULT_CONFIG };
let lastTextSent = "";
let activeInput = null;
let activeSendButton = null;
let overlayElement = null;
let isInterventionActive = false;
let isChecking = false; // Flag to prevent Enter presses during API check
let isHooked = false;
let isSendButtonHooked = false;
let debounceTimer = null;
let abortController = null;
let autoHideTimer = null; // Timer for auto-hiding overlay for low scores

console.log("[RegretGPT] Content script loaded");

// Load configuration from storage
async function loadConfig() {
  try {
    const stored = await chrome.storage.sync.get(['backendUrl', 'regretThreshold', 'enabled']);
    if (stored.backendUrl) config.backendUrl = stored.backendUrl;
    if (stored.regretThreshold !== undefined) config.regretThreshold = stored.regretThreshold;
    if (stored.enabled !== undefined) config.enabled = stored.enabled;
    console.log("[RegretGPT] Config loaded:", config);
  } catch (e) {
    console.warn("[RegretGPT] Failed to load config, using defaults:", e);
  }
}

// Initialize config on load
loadConfig();

// Utility: find the message input on Telegram Web
function findTelegramInput() {
  // Try multiple selectors for Telegram Web
  // Modern Telegram Web uses various selectors
  const selectors = [
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    'div[contenteditable="true"]',
    '.input-message-input',
    '#editable-message-text'
  ];

  for (const selector of selectors) {
    const candidates = document.querySelectorAll(selector);
    if (candidates.length) {
      // Prefer the one with role="textbox" or in the message input area
      for (const el of candidates) {
        const ariaRole = el.getAttribute("role");
        const parent = el.closest('[class*="input"], [class*="message"], [class*="composer"]');
        if (ariaRole === "textbox" || parent) {
          console.log("[RegretGPT] Found input with selector:", selector);
          return el;
        }
      }
      // Fallback to first match
      console.log("[RegretGPT] Found input with selector (fallback):", selector);
      return candidates[0];
    }
  }
  
  console.log("[RegretGPT] No input found with any selector");
  return null;
}

// Utility: find the send button on Telegram Web
function findSendButton() {
  const selectors = [
    'button[title*="Send"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
    '.btn-send',
    '[data-testid="send"]',
    'button[type="submit"]',
    'button.send-button',
    'button[class*="send"]'
  ];

  for (const selector of selectors) {
    const button = document.querySelector(selector);
    if (button) {
      // Make sure it's actually a send button by checking if it's near the input
      const input = findTelegramInput();
      if (input) {
        const inputContainer = input.closest('[class*="input"], [class*="message"], [class*="composer"], [class*="footer"]');
        if (inputContainer && (inputContainer.contains(button) || button.closest('[class*="input"], [class*="message"], [class*="composer"], [class*="footer"]'))) {
          console.log("[RegretGPT] Found send button with selector:", selector);
          return button;
        }
      }
      // Fallback: if we can't verify, still return it
      console.log("[RegretGPT] Found send button with selector (fallback):", selector);
      return button;
    }
  }
  
  console.log("[RegretGPT] No send button found with any selector");
  return null;
}

// Create overlay UI
function createOverlay() {
  if (overlayElement) return overlayElement;

  overlayElement = document.createElement("div");
  overlayElement.id = "regretgpt-overlay";
  overlayElement.innerHTML = `
    <div class="regretgpt-modal">
      <div class="regretgpt-header">
        <span>RegretGPT Intervention</span>
      </div>
      <div class="regretgpt-body">
        <p id="regretgpt-message">Hmm.</p>
        <p id="regretgpt-reason"></p>
        <div id="regretgpt-sim"></div>
        <div id="regretgpt-puzzle" class="regretgpt-puzzle hidden">
          <p id="regretgpt-puzzle-question"></p>
          <input id="regretgpt-puzzle-answer" type="text" placeholder="Your answer" />
          <button id="regretgpt-puzzle-submit">Submit</button>
          <p id="regretgpt-puzzle-error" class="regretgpt-error"></p>
        </div>
      </div>
      <div class="regretgpt-footer">
        <button id="regretgpt-cancel">Cancel</button>
        <button id="regretgpt-send-anyway">Send anyway</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlayElement);

  // Event bindings
  document
    .getElementById("regretgpt-cancel")
    .addEventListener("click", handleCancel);

  document
    .getElementById("regretgpt-send-anyway")
    .addEventListener("click", handleSendAnywayClick);

  document
    .getElementById("regretgpt-puzzle-submit")
    .addEventListener("click", handlePuzzleSubmit);

  return overlayElement;
}

let currentPuzzle = null;
let pendingSendAction = null; // function that actually sends the message when allowed

function showOverlay(data, sendAction) {
  isInterventionActive = true;
  pendingSendAction = sendAction;

  const overlay = createOverlay();
  overlay.style.display = "flex";

  const msgEl = document.getElementById("regretgpt-message");
  const reasonEl = document.getElementById("regretgpt-reason");
  const simEl = document.getElementById("regretgpt-sim");
  const puzzleEl = document.getElementById("regretgpt-puzzle");

  msgEl.textContent = data.llm_message || "Bro… you sure about this?";
  reasonEl.textContent = `Reason: ${data.reason || "High-regret behaviour detected."}`;
  simEl.textContent = data.simulation || "";

  if (data.intervention_strength === "BLOCK_HARD" || data.intervention_strength === "PUZZLE") {
    puzzleEl.classList.remove("hidden");
    generatePuzzle();
  } else {
    puzzleEl.classList.add("hidden");
  }
}

function hideOverlay() {
  // Clear any auto-hide timer
  if (autoHideTimer) {
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }
  
  if (overlayElement) overlayElement.style.display = "none";
  isInterventionActive = false;
  isChecking = false; // Reset checking flag when overlay is hidden
  currentPuzzle = null;
  pendingSendAction = null;
}

// Generate puzzle with varying difficulty
function generatePuzzle() {
  const puzzleTypes = [
    {
      type: "math",
      generate: () => {
        const ops = [
          { op: "+", fn: (a, b) => a + b },
          { op: "-", fn: (a, b) => a - b },
          { op: "*", fn: (a, b) => a * b }
        ];
        const selected = ops[Math.floor(Math.random() * ops.length)];
        const a = Math.floor(Math.random() * 20) + 1;
        const b = Math.floor(Math.random() * 20) + 1;
        const answer = selected.fn(a, b);
        return {
          question: `If you REALLY want to do this, prove you're not impulsive: ${a} ${selected.op} ${b} = ?`,
          answer: answer,
          type: "math"
        };
      }
    },
    {
      type: "reverse",
      generate: () => {
        const words = ["hello", "world", "think", "pause", "calm", "wait"];
        const word = words[Math.floor(Math.random() * words.length)];
        return {
          question: `Type "${word}" backwards:`,
          answer: word.split("").reverse().join(""),
          type: "reverse"
        };
      }
    },
    {
      type: "count",
      generate: () => {
        const text = "RegretGPT";
        const letter = text[Math.floor(Math.random() * text.length)];
        return {
          question: `How many times does "${letter}" appear in "RegretGPT"?`,
          answer: text.split(letter).length - 1,
          type: "count"
        };
      }
    }
  ];

  const selectedType = puzzleTypes[Math.floor(Math.random() * puzzleTypes.length)];
  const puzzle = selectedType.generate();
  currentPuzzle = puzzle;

  document.getElementById("regretgpt-puzzle-question").textContent = puzzle.question;
  document.getElementById("regretgpt-puzzle-answer").value = "";
  document.getElementById("regretgpt-puzzle-error").textContent = "";
}

function handlePuzzleSubmit() {
  if (!currentPuzzle) return;
  const input = document.getElementById("regretgpt-puzzle-answer").value.trim();
  const errEl = document.getElementById("regretgpt-puzzle-error");

  let isCorrect = false;
  if (currentPuzzle.type === "math") {
    isCorrect = parseInt(input, 10) === currentPuzzle.answer;
  } else {
    isCorrect = input.toLowerCase() === String(currentPuzzle.answer).toLowerCase();
  }

  if (isCorrect) {
    errEl.textContent = "";
    // Allow send
    if (pendingSendAction) pendingSendAction();
    hideOverlay();
  } else {
    errEl.textContent = "Nope. Try again. Maybe this is a sign.";
    // Regenerate puzzle after wrong answer
    setTimeout(() => generatePuzzle(), 1000);
  }
}

function handleCancel() {
  hideOverlay();
  // User cancels: do nothing
}

function handleSendAnywayClick() {
  // Only allow direct override when intervention is "WARN" type –
  // but for the demo we can just gate through the puzzle.
  const puzzleEl = document.getElementById("regretgpt-puzzle");
  if (!puzzleEl.classList.contains("hidden")) {
    // force puzzle
    document.getElementById("regretgpt-puzzle-error").textContent =
      "Solve the puzzle first, impulsive creature.";
  } else {
    if (pendingSendAction) pendingSendAction();
    hideOverlay();
  }
}

// Send text to backend for classification with timeout
async function checkRegretAndMaybeIntervene(text, context) {
  // Cancel any pending request
  if (abortController) {
    abortController.abort();
  }
  abortController = new AbortController();

  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, config.requestTimeout);

  try {
    console.log("[RegretGPT] Sending request to backend:", config.backendUrl);
    const payload = {
      typed_text: text,
      url: window.location.href,
      time_iso: new Date().toISOString(),
      context
    };

    const res = await fetch(`${config.backendUrl}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: abortController.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      console.error("[RegretGPT] Backend error", res.status, res.statusText);
      // If backend is down, don't block messages
      return { shouldBlock: false, data: { regret_score: 0 }, error: `Backend error: ${res.status}` };
    }

    const data = await res.json();
    console.log("[RegretGPT] Backend response:", data);

    // Always return data, but indicate if it should block based on threshold
    const shouldBlock = data.regret_score >= config.regretThreshold;
    return {
      shouldBlock: shouldBlock,
      data: data,
      showOverlay: true // Always show overlay, even for low scores
    };
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      console.warn("[RegretGPT] Request timeout");
      return { shouldBlock: false, data: { regret_score: 0 }, error: "Request timeout" };
    }
    console.error("[RegretGPT] Error contacting regret backend", e);
    // If backend is unreachable, don't block messages
    return { shouldBlock: false, data: { regret_score: 0 }, error: e.message };
  } finally {
    abortController = null;
  }
}

// Shared function to handle message send (used by both Enter key and send button)
async function handleMessageSend(input, sendButton) {
  // Check if extension is enabled
  if (!config.enabled) {
    return false; // Let message send normally
  }

  // Block if intervention is active OR if we're currently checking
  if (isInterventionActive || isChecking) {
    console.log("[RegretGPT] Blocking send - intervention active or check in progress");
    return true; // Blocked
  }

  // Clear any pending debounce
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  // Immediately set checking flag to block subsequent attempts
  isChecking = true;

  const text = input.innerText.trim() || input.textContent.trim();
  console.log("[RegretGPT] Intercepted message:", text);

  if (!text) {
    console.log("[RegretGPT] Empty message, allowing send");
    isChecking = false; // Reset flag
    return false; // Allow empty message to send
  }

  // Debounce: wait a bit before checking (user might still be typing)
  debounceTimer = setTimeout(async () => {
    try {
      console.log("[RegretGPT] Checking with backend...");
      const { shouldBlock, data, error, showOverlay: shouldShowOverlay } = await checkRegretAndMaybeIntervene(text, {
        app: "telegram",
        reason_hint: "messaging"
      });

      console.log("[RegretGPT] Backend response - shouldBlock:", shouldBlock, "score:", data?.regret_score);

      const sendAction = () => {
        console.log("[RegretGPT] Executing send action");
        // Try to click the send button if available, otherwise simulate Enter
        if (sendButton) {
          sendButton.click();
        } else {
          // Fallback: simulate Enter key
          const enterEvent = new KeyboardEvent("keydown", { 
            key: "Enter", 
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          });
          input.dispatchEvent(enterEvent);
        }
      };

      // Always show overlay if data exists
      if (data && shouldShowOverlay) {
        console.log("[RegretGPT] Showing overlay with score:", data.regret_score);
        showOverlay(data, sendAction);
        
        // If score is below threshold, auto-hide after 2 seconds and send
        if (!shouldBlock) {
          console.log("[RegretGPT] Low score detected, will auto-hide in 2 seconds");
          autoHideTimer = setTimeout(() => {
            console.log("[RegretGPT] Auto-hiding overlay and sending message");
            if (pendingSendAction) {
              isChecking = false; // Reset flag before sending
              pendingSendAction();
            }
            hideOverlay();
          }, 2000); // 2 seconds
        }
        // Keep isChecking = true while overlay is shown (isInterventionActive will be true)
      } else {
        // No data or error - allow message to send
        console.log("[RegretGPT] No data or error, allowing send");
        isChecking = false; // Reset flag before sending
        sendAction();
      }
    } catch (error) {
      console.error("[RegretGPT] Error during check:", error);
      isChecking = false; // Reset flag on error
      // On error, allow the message to send
      if (sendButton) {
        sendButton.click();
      } else {
        const enterEvent = new KeyboardEvent("keydown", { 
          key: "Enter", 
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        });
        input.dispatchEvent(enterEvent);
      }
    }
  }, config.debounceDelay);

  return true; // Blocked (we're handling it)
}

// Core: intercept send action on Telegram Web
function setupTelegramHook() {
  if (isHooked && isSendButtonHooked) {
    return; // Already hooked
  }

  const input = findTelegramInput();
  if (!input) {
    console.log("[RegretGPT] No Telegram input found yet.");
    return;
  }

  // Check if this is the same input we already hooked
  if (activeInput === input && isHooked) {
    // Still need to check send button
    if (!isSendButtonHooked) {
      setupSendButtonHook();
    }
    return;
  }

  activeInput = input;
  isHooked = true;
  console.log("[RegretGPT] Hooked into Telegram input:", input);

  // Intercept Enter key - use capture phase to catch it early
  input.addEventListener("keydown", async (e) => {
    console.log("[RegretGPT] Keydown event:", e.key, "Shift:", e.shiftKey, "Active:", isInterventionActive, "Checking:", isChecking);
    
    if (e.key === "Enter" && !e.shiftKey) {
      const sendButton = findSendButton();
      const blocked = await handleMessageSend(input, sendButton);
      
      if (blocked) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      } else if (!config.enabled) {
        // Extension disabled, let it through
        return;
      } else {
        // Empty message, allow it
        return;
      }
    }
  }, true); // Use capture phase

  // Also hook the send button
  setupSendButtonHook();
}

// Hook the send button to intercept clicks
function setupSendButtonHook() {
  if (isSendButtonHooked) {
    return; // Already hooked
  }

  const sendButton = findSendButton();
  if (!sendButton) {
    console.log("[RegretGPT] No send button found yet.");
    return;
  }

  // Check if this is the same button we already hooked
  if (activeSendButton === sendButton) {
    return;
  }

  activeSendButton = sendButton;
  isSendButtonHooked = true;
  console.log("[RegretGPT] Hooked into send button:", sendButton);

  // Intercept click events - use capture phase to catch it early
  sendButton.addEventListener("click", async (e) => {
    console.log("[RegretGPT] Send button clicked, Active:", isInterventionActive, "Checking:", isChecking);
    
    const input = findTelegramInput();
    if (!input) {
      console.log("[RegretGPT] No input found, allowing send");
      return; // Can't check, let it through
    }

    const blocked = await handleMessageSend(input, sendButton);
    
    if (blocked) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }, true); // Use capture phase
}

// Retry in case DOM loads slowly
function init() {
  console.log("[RegretGPT] Initializing...");
  
  const trySetup = () => {
    if (!isHooked) {
      setupTelegramHook();
    } else if (!isSendButtonHooked) {
      // Input is hooked but send button isn't, try to hook it
      setupSendButtonHook();
    }
  };

  // Try immediately
  trySetup();
  
  // Also try after a short delay (DOM might not be ready)
  setTimeout(trySetup, 1000);
  setTimeout(trySetup, 3000);
  
  // Watch for DOM changes
  const observer = new MutationObserver(() => {
    if (!isHooked) {
      trySetup();
    }
  });
  
  observer.observe(document.body, { 
    childList: true, 
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'role']
  });
  
  // Also listen for focus events on potential inputs
  document.addEventListener('focusin', (e) => {
    if (e.target.contentEditable === 'true' || e.target.getAttribute('contenteditable') === 'true') {
      console.log("[RegretGPT] Input focused, attempting hook");
      isHooked = false; // Reset to allow re-hooking
      isSendButtonHooked = false; // Reset send button hook too
      activeSendButton = null;
      trySetup();
    }
  }, true);

  // Watch for send button changes (DOM mutations)
  const sendButtonObserver = new MutationObserver(() => {
    if (!isSendButtonHooked) {
      setupSendButtonHook();
    }
  });

  sendButtonObserver.observe(document.body, { 
    childList: true, 
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'title', 'aria-label']
  });
}

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
