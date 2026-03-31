# ARES Backend — Setup Instructions

## Overview
The ARES backend is a Google Apps Script that:
- Serves live property data as a JSON feed to the website
- Runs AI vetting (EPA + Claude scoring) on new listings
- Caches results for performance

---

## Step 1: Create the Google Sheet

1. Go to sheets.google.com → create a new blank sheet
2. Name it: **ARES Property Database**
3. Rename the first tab (bottom): **Properties**
4. In Row 1, add these exact headers in order (one per column, A through AI):

```
ID | Status | Address | City | State | County | ZIP | Lat | Lng | Price |
Lot SqFt | Bldg SqFt | Zoning | Zoning Label | Property Type | Current Use |
Year Built | Is Vacant | Vacant Since | Is Grandfathered | EPA Status |
Fleet Suitable | Fleet Features | Title Flags | Deed Restrictions | Has Title Data |
GF Risk Factors | Description | Listing Source | AI Score | AI Flags |
AI Summary | EPA Facility Count | Last Vetted | Notes
```

**Status values:** Draft | Pending | Approved | Rejected
- Set to **Pending** when you're ready to run vetting
- Set to **Approved** manually after reviewing AI output
- Only **Approved** rows appear on the website

**Property Type values:** retail-auto | fleet | commercial-vehicle | industrial

**Boolean columns** (Is Vacant, Is Grandfathered, Fleet Suitable, Has Title Data): use TRUE / FALSE

**List columns** (Fleet Features, Title Flags, Deed Restrictions, GF Risk Factors): comma-separated text

---

## Step 2: Add the Apps Script

1. In your Google Sheet: **Extensions → Apps Script**
2. Delete the default `myFunction()` code
3. Copy the entire contents of `Code.gs` and paste it in
4. Click **Save** (floppy disk icon)
5. Name the project: **ARES Backend**

---

## Step 3: Add your Anthropic API Key

1. In Apps Script: **Project Settings** (gear icon, left sidebar)
2. Scroll to **Script Properties** → click **Add script property**
3. Property name: `ANTHROPIC_API_KEY`
4. Value: your Anthropic API key (sk-ant-...)
5. Click **Save script properties**

> The key is stored securely in Google's infrastructure — never in the code.

---

## Step 4: Deploy as a Web App

1. In Apps Script: click **Deploy → New deployment**
2. Click the gear icon next to "Select type" → choose **Web app**
3. Settings:
   - Description: `ARES Property Feed v1`
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click **Deploy**
5. **Copy the Web App URL** — it looks like:
   `https://script.google.com/macros/s/XXXXXXXXX/exec`
6. Paste this URL into `property-search.html` where indicated (search for `FEED_URL`)

---

## Step 5: Set up the vetting trigger

1. In Apps Script: click **Triggers** (clock icon, left sidebar)
2. Click **+ Add Trigger** (bottom right)
3. Settings:
   - Function: `runVetting`
   - Event source: **Time-driven**
   - Type: **Minutes timer** → Every **30 minutes**
4. Click **Save**

> Now every 30 minutes, any row with Status = **Pending** will be automatically vetted.
> You'll get EPA data, an AI score, flags, and a summary written back to the sheet.
> Review the output, then manually change Status to **Approved** to push it live.

---

## Step 6: Add your first property

Fill in a row in the Properties sheet:
- Give it an ID (e.g. `WA-001` for Washington, `OR-001` for Oregon, `CA-001` for California)
- Fill in address, city, state, county, zip, lat, lng, price, lot size, zoning, etc.
- Set Status to **Pending**
- Wait for the trigger to run (or run `runVetting` manually from the Apps Script editor)
- Review the AI Score, AI Flags, and AI Summary columns
- If it looks good: change Status to **Approved**
- The website will show it within 1 hour (or run `bustCache` to show it immediately)

---

## Workflow Summary

```
You find a property
        ↓
Add to Google Sheet (Status: Pending)
        ↓
Apps Script runs vetting (EPA + AI score + summary)
        ↓
You review AI output in the sheet
        ↓
Set Status: Approved
        ↓
Website shows it automatically (within 1 hour)
```

---

## I-5 Corridor ID Convention

Use state prefix + sequential number:
- Washington: `WA-001`, `WA-002` ...
- Oregon: `OR-001`, `OR-002` ...
- California: `CA-001`, `CA-002` ...

When expanding to new counties, just add them — the filter panel on the website
will automatically include them. Update the County filter checkboxes in
`property-search.html` to add OR and CA counties as you expand.
