# Ticker

A simple iPhone price tracker for cross-border shopping trips from Singapore to Johor Bahru.

**App:** https://xolebtay.github.io/ticker/

Ticker keeps every receipt from each trip and shows how prices change over time - which items
got cheaper or dearer since the last visit, how petrol prices move, and what each trip cost
in ringgit (RM) and Singapore dollars (S$).

## Features

- **Prices** - search any item, see its full price history, cheapest and dearest, with
  green / red badges against the last purchase and a petrol price chart
- **Trips** - totals per trip, per shop and per category, in RM and S$
- **Add receipt** - enter a receipt line by line, with suggestions from past items and a
  check that the lines add up to the receipt total
- **Scan receipt** - take a photo and the text is read on the phone (free, no account),
  then corrected on screen before saving
- **Backup** - export and import all data as one file (e.g. to iCloud Drive)
- Works offline once added to the Home Screen

## Privacy

There is no server and no account. All trip data is stored only on the device, in Safari's
storage. This repository contains the app files only - never any receipts or trip data.

## Install on iPhone

1. Open the app link in **Safari**
2. Tap **Share** -> **Add to Home Screen**
3. Open Ticker from the Home Screen icon and import a data file or backup

## Built with

Plain HTML, CSS and JavaScript - no build step. Receipt scanning uses
[Tesseract.js](https://github.com/naptha/tesseract.js) 5.1.1 (Apache 2.0 licence), kept in the
`tesseract/` folder of this repository so the app never loads code from other websites.
