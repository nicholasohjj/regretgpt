# RegretGPT - Impulse Control Assistant

A Chrome extension that uses AI to predict and prevent high-regret actions (like sending impulsive messages).

## Setup Instructions

### 1. Backend Setup

#### Install Dependencies
```bash
# Activate your virtual environment (if not already activated)
# On Windows:
venv\Scripts\activate

# Install dependencies
pip install -r backend/requirements.txt
```

#### Set Up Environment Variable
Create a `.env` file in the `backend` folder (or set the environment variable):

```bash
# In backend/.env or as environment variable
GEMINI_API_KEY=your_gemini_api_key_here
```

To get a Gemini API key:
1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Create a new API key
3. Copy it to your `.env` file

#### Run the Backend Server
```bash
# Make sure you're in the backend directory or have it in your path
cd backend
python main.py
```

The server will run on `http://localhost:8000`

### 2. Chrome Extension Setup

#### Load the Extension
1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked**
4. Select the `extension` folder from this project
5. The extension should now be loaded

#### Note
The extension works on:
- Telegram Web (`https://web.telegram.org/*`)
- Gmail (`https://mail.google.com/*`)
- Instagram (`https://www.instagram.com/*`)
- WhatsApp Web (`https://web.whatsapp.com/*`)

### 3. Usage

1. Make sure the backend server is running (`python backend/main.py`)
2. Navigate to one of the supported websites (e.g., Telegram Web)
3. Start typing a message
4. When you press Enter, the extension will:
   - Send your message to the backend for analysis
   - If the regret score is high (≥70), show an intervention popup
   - Require you to solve a puzzle for high-risk messages

## Troubleshooting

### Backend not responding
- Check that the server is running on port 8000
- Verify your `GEMINI_API_KEY` is set correctly
- Check the console for error messages

### Extension not working
- Make sure the backend is running first
- Check Chrome's extension console for errors
- Verify you're on a supported website
- Reload the extension if you made changes

### API Key Issues
- Make sure your Gemini API key is valid
- Check that you have API access enabled in Google AI Studio

## Configuration

The extension supports configuration via Chrome storage. You can customize:
- **Backend URL**: Default is `http://localhost:8000`
- **Regret Threshold**: Default is 70 (0-100 scale)
- **Enable/Disable**: Toggle the extension on/off

To configure, use Chrome's storage API or create a settings page (future enhancement).

## Environment Variables

Backend supports the following environment variables:
- `GEMINI_API_KEY`: Required - Your Google Gemini API key
- `PORT`: Optional - Server port (default: 8000)
- `HOST`: Optional - Server host (default: 0.0.0.0)
- `ENVIRONMENT`: Optional - Set to "production" for stricter CORS (default: development)
- `ALLOWED_ORIGINS`: Optional - Comma-separated list of allowed CORS origins

## Project Structure

```
hacknroll/
├── backend/
│   ├── main.py              # FastAPI server
│   ├── regret_model.py      # AI classification logic
│   └── requirements.txt     # Python dependencies
├── extension/
│   ├── manifest.json        # Extension manifest
│   ├── contentScript.js     # Main extension logic
│   ├── background.js        # Background service worker
│   └── overlay.css          # Intervention UI styles
├── .gitignore              # Git ignore rules
├── IMPROVEMENTS.md         # List of improvements made
└── README.md               # This file
```

## Recent Improvements

See [IMPROVEMENTS.md](IMPROVEMENTS.md) for a detailed list of improvements including:
- Enhanced security (CORS, input validation, timeouts)
- Configuration system
- Better error handling and retry logic
- Improved puzzle system with multiple types
- Request debouncing and cancellation
- Better logging and debugging

