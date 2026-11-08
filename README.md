# Adam Nokia Electronics — Web App

This repository root contains the published PWA. GitHub Pages must publish **main / root** (Deploy from a branch). The homepage is `index.html`; the README is not the homepage.

## Configure the backend
After deploying the Google Apps Script Web App, open `js/config.js` and set `API_URL` to the exact Apps Script `/exec` URL. Commit the change. Do not put passwords, setup codes, spreadsheet IDs, staff data, or business records in this repository.

## Current release
This is the 0.3.0 pilot frontend. It supports dashboard, POS, inventory, customer/credit payments, branch collections and settings against the matching Apps Script backend. It is not yet the complete planned finance/purchasing system: supplier purchase orders, supplier balances, expenses, invoices/receipts document centre, daily closing and reconciliation reports are not implemented in this pilot.
