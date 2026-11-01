# Signboard Tax Calculator

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

## Project layout

| Path | Contents |
| --- | --- |
| `index.html` | Page markup, including the default Thai text |
| `css/styles.css` | Styles and colour variables |
| `js/app.js` | Calculator, tax rates, language switch, page interactions |
| `js/i18n.js` | English text |
| `assets/` | Images, logo, fonts, and the P.P.1 form PDF |

## Calculation

`tax = width (cm) x length (cm) x rate ÷ 500`

| Lettering type | Message or image can change | Cannot change |
| --- | --- | --- |
| Type 1 | 10 | 5 |
| Type 2 | 52 | 26 |
| Type 3 | 52 | 50 |

To change a rate, edit `RATES` in `js/app.js` and the matching row in the table in `index.html`.
