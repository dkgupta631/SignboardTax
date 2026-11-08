# Signage Tax Calculator

A static, bilingual (Thai by default, English on toggle) sign tax calculator. It has no build step and no dependencies, and all images and fonts are served from this repository.

## Run locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. Add `?lang=en` to the URL to open it in English.

## Publish on GitHub Pages

1. Push this repository to GitHub.
2. Go to **Settings → Pages**, then under **Build and deployment** choose **Deploy from a branch**, with `main` and `/ (root)`.
3. The site appears at `https://<account>.github.io/SignboardTax/`.

## Login and registration

Every page can be read without an account, but scanning a sign, calculating the tax and downloading the P.P.1 form need a sign-in. Trying one of them while signed out opens the sign-in screen, and the action continues after signing in. The **Sign in** button in the header opens the login, registration and forgot-password screen as an overlay. Accounts live in the **SignageTax** Google Sheet: the `District_code` tab supplies the registration offices, and new members are added to the `Customer` tab. A Google Apps Script web app connects the two.

### One-time setup

1. Open the SignageTax spreadsheet and choose **Extensions → Apps Script**.
2. Replace the editor's contents with `google-apps-script/Code.gs` and save.
3. Choose the `setup` function and press **Run**. Approve the permission prompt. This writes the column headings to the `Customer` tab.
4. Choose **Deploy → New deployment**, pick the type **Web app**, and set:
   - **Execute as:** Me
   - **Who has access:** Anyone
5. Press **Deploy** and copy the web app URL that ends in `/exec`.
6. Paste that URL into `scriptUrl` in `js/auth-config.js`, then commit and push.

After changing `Code.gs` later, use **Deploy → Manage deployments → Edit → Version: New version**. This keeps the same URL.

### How it works

| Action | What the script does |
| --- | --- |
| Register | Checks the district code exists, rejects a duplicate email or phone, and appends a row to `Customer` |
| Sign in | Matches the email or phone number with the password, and records the time in `Last Login` |
| Forgot password | Shows the stored password for a registered email or phone number |
| My profile | Shows and updates the member's office, name, phone, email and address. A duplicate email or phone is rejected |
| Change password | Checks the current password, saves the new one, and signs out the member's other devices |

Signing in returns a session token, stored in the `Session Token` column. The profile actions only work with a matching token, so nobody can edit another member's details. Changing the password issues a new token.

`District_code` is read from row 4 down: column B is the code and column C is the office name. The `Customer` columns are Customer ID, Registered At, District Code, District Name, Name, Phone, Email, Password, Address, Last Login, Session Token, Updated At. The script adds any missing headings itself.

### Security limits

- Passwords are stored as plain text in the sheet, because the forgot-password screen has to show them. Anyone with access to the sheet can read them.
- Anyone who knows a member's email or phone number can see that member's password on the forgot-password screen.
- The members-only lock runs in the browser. Someone who knows the PDF's direct address, or edits the page in developer tools, can still get past it.

## Project layout

| Path | Contents |
| --- | --- |
| `index.html` | Page markup, including the default Thai text |
| `css/styles.css` | Styles and colour variables |
| `js/app.js` | Calculator, tax rates, language switch, page interactions |
| `js/i18n.js` | English text |
| `js/auth.js`, `css/auth.css` | Login, registration and forgot-password screens, and the signed-in account menu |
| `js/auth-config.js` | The Apps Script web app URL |
| `google-apps-script/Code.gs` | Backend that reads and writes the Google Sheet |
| `js/mobile-app.js` | Screen switching for the header menu and phone tab bar, install prompt |
| `js/ar-measure.js`, `js/scan-voice.js` | Real-time sign measuring with AR, and the success voice clip |
| `sw.js`, `manifest.webmanifest` | Offline support and home-screen install |
| `assets/` | Images, logo, fonts, and the P.P.1 form PDF |

## Measuring a sign in real time

The "Measure the sign" button uses augmented reality (WebXR), like Google's Measure app. The phone tracks real distances in 3D, so no reference item is needed:

1. Move the phone slowly until the centre circle turns green. The screen shows the distance to the sign.
2. Aim the circle at the sign's top left, top right, bottom right and bottom left corners, tapping + at each one. The length of each side shows as you go.
3. The width and length are filled in automatically.

It works only in **Chrome on Android phones that support Google Play Services for AR**, and only over https (the GitHub Pages address, not a file opened on a computer). The list of supported phones is at https://developers.google.com/ar/devices. iPhones and computers show a message asking for the size to be typed instead.

For accurate results, stand 1 to 4 m from the sign, move the phone slowly at the start so it can find the wall, and aim exactly at each corner. Figures for tax filing should still be checked with a tape measure.

## Calculation

`tax = width (cm) x length (cm) x rate ÷ 500`

| Lettering type | Message or image can change | Cannot change |
| --- | --- | --- |
| Type 1 | 10 | 5 |
| Type 2 | 52 | 26 |
| Type 3 | 52 | 50 |

To change a rate, edit `RATES` in `js/app.js` and the matching row in the table in `index.html`.

## Screens

The site shows one screen at a time: Home, Rates, Calculate, Guide and Contact. Each section in `index.html` names its screen with `data-screen`. On desktop the header menu switches screens and the footer shows on every screen.

## Phone app mode

At 760px wide and below, the same screens are switched from a bottom tab bar. On GitHub Pages it can be installed to the home screen and used offline. If you add a new asset, add it to `FILES` in `sw.js` too.
