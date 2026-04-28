# Notes Web App with AI Reminder Bot

This is a modern Notes web application built with:
- Frontend: HTML, CSS, Vanilla JavaScript
- Backend: Node.js + Express
- AI reminder bot simulation with mock WhatsApp logic

## Run
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the server:
   ```bash
   npm start
   ```
3. Open browser at:
   ```
   http://localhost:3000
   ```

## Features
- Home page with 3 categories: Shtepia, Puna, Shkolla
- Add and store notes locally in browser `localStorage`
- AI reminder bot endpoint to parse commands like `ma kujto note 2 neser ne oren 8`
- Simulated WhatsApp message sending with mock function
- Reminder checker runs every 5 seconds
- Settings page to store WhatsApp number and view reminder history

## Notes
- No database is used for notes; notes are stored in the browser.
- Reminders are kept in server memory only and will reset when the server restarts.
