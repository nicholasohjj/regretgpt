// background.js

chrome.runtime.onInstalled.addListener(() => {
    console.log("RegretGPT installed.");
  });
  
  // Optional relay between content script and backend
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "CHECK_REGRET") {
      // You can also just fetch from contentScript; this is if you want central routing.
      fetch("http://localhost:8000/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message.payload)
      })
        .then(res => res.json())
        .then(data => sendResponse({ ok: true, data }))
        .catch(err => {
          console.error("Error calling backend", err);
          sendResponse({ ok: false, error: err.toString() });
        });
  
      return true; // keep channel open for async sendResponse
    }
  });

