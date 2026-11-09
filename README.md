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
3. Choose the `setup` function and press **Run**. Approve the permission prompt, which asks for Sheets and Drive. This writes the column headings to the `Customer` and `banners` tabs and creates the Drive folder for scan photos.
4. Choose **Deploy → New deployment**, pick the type **Web app**, and set:
   - **Execute as:** Me
   - **Who has access:** Anyone
5. Press **Deploy** and copy the web app URL that ends in `/exec`.
6. Paste that URL into `scriptUrl` in `js/auth-config.js`, then commit and push.

After changing `Code.gs` later, use **Deploy → Manage deployments → Edit → Version: New version**. This keeps the same URL. If the new code uses a Google service the old one did not (sign records added Drive), run `setup` once more first and approve the new permission.

### How it works

| Action | What the script does |
| --- | --- |
| Register | Checks the district code exists, allows at most 5 members per registration office code, rejects a duplicate email or phone, and appends a row to `Customer` |
| Sign in | Matches the email or phone number with the password, and records the time in `Last Login` |
| Forgot password | Shows the stored password for a registered email or phone number |
| My profile | Shows and updates the member's office, name, phone, email and address. A duplicate email or phone is rejected |
| Change password | Checks the current password, saves the new one, and signs out the member's other devices |
| Save sign | Adds a row to `banners` for the member's sign, or updates their own earlier row. See [Sign records](#sign-records) |

Each registration office code takes at most 5 members (`MAX_PER_OFFICE` in `Code.gs`). Picking a full office on the registration or profile form, or submitting one, opens a notice with both LINE QR codes and both phone numbers so the customer can contact staff. Moving a profile to a full office is refused the same way.

Signing in returns a session token, stored in the `Session Token` column. The profile actions only work with a matching token, so nobody can edit another member's details. Changing the password issues a new token.

`District_code` is read from row 4 down: column B is the code and column C is the office name. The `Customer` columns are Customer ID, Registered At, District Code, District Name, Name, Phone, Email, Password, Address, Last Login, Session Token, Updated At. The script adds any missing headings itself.

### Security limits

- Passwords are stored as plain text in the sheet, because the forgot-password screen has to show them. Anyone with access to the sheet can read them.
- Anyone who knows a member's email or phone number can see that member's password on the forgot-password screen.
- The members-only lock runs in the browser. Someone who knows the PDF's direct address, or edits the page in developer tools, can still get past it.

## Sign records

Every sign a member measures is saved to the `banners` tab with their Customer ID.

1. After a successful scan, the record is saved at once with the size and the scan photo, and a map opens. It starts at the phone's GPS position.
2. The member moves the map until the fixed pin sits on the sign, adds a shop name or note if they like, and presses **Confirm location**. The same row gets the latitude, longitude, a Google Maps link and the street address.
3. When they press **Calculate**, the row gets the sign type, font type, rate and tax.

A sign typed in by hand is saved when it is calculated, and can be pinned from the **Sign location** card above the form. Typing a different width or length starts a new row; **Start again** also starts a new one. The location must be pinned at street level (zoom 16 or closer).

The `banners` columns are Banner ID, Saved At, Updated At, Customer ID, Customer Name, Phone, District Code, District Name, Width (cm), Length (cm), Area (sq cm), Sign Type, Font Type, Rate (baht / 500 sq cm), Tax (baht / year), Measured By (Scan, Scan (edited) or Typed in), Latitude, Longitude, Google Maps, Address, Note, Photo. Sizes, rate and tax are stored as numbers. The script works out the tax itself rather than trusting the browser. Photos go to the **Signage Tax banner photos** folder in the Drive of the account that deployed the script, and stay private to that account.

The map is Esri's World Street Map, with Esri satellite imagery, shown with Leaflet (`assets/vendor/leaflet`, loaded only when the map opens). Addresses come from OpenStreetMap's Nominatim, in Thai. Neither needs an API key. An in-page Google map would need a Google Maps API key with billing turned on.

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
| `js/scanner.js`, `js/sign-detect.js`, `js/scan-measure.js` | Sign scanner: camera, automatic outline and edge snapping, corner marking with a magnifier, size measurement |
| `js/banner-map.js`, `css/banner-map.css` | Sign location map and the sign records saved to the `banners` tab |
| `sw.js`, `manifest.webmanifest` | Offline support and home-screen install |
| `assets/` | Images, logo, fonts, and the P.P.1 form PDF |

## Sign scanner

The scanner measures a sign's width and length from one photo, in one step. After the photo it finds the sign's four corners (orange) and the A4 sheet stuck on it (green) by itself, and the customer only presses Measure. The sign's corners give its shape and perspective, and the A4 sheet gives the real size. If either is not found, the customer drags those points onto the corners on the same screen; a magnifier appears while dragging and points snap onto clear edges. Without an A4 sheet the scanner will not give a result, because one photo cannot show real size on its own.

For accurate results:

- Stick a plain white A4 sheet flat on the sign. Do not hold it in front of the sign.
- Show the whole sign with all four corners, as large as possible on the screen.
- Check that the orange points sit on the sign's corners and the green points on the paper's corners.

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
