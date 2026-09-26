# Web Scraping with Regular Expressions in Python: A Step-by-Step Tutorial

Real web pages are messy. Markup changes from one release to the next, class names get renamed, and the values you want often sit inside strings that don't follow a consistent format. Regular Expressions (RegEx) let you describe exactly what to pull out of that markup, with enough flexibility to handle the variation. This tutorial explains what RegEx is, walks through the tokens you'll use most, and then builds a working Python scraper that collects product titles and prices from the Oxylabs sandbox.

## What Are Regular Expressions?

A regular expression is a sequence of characters that defines a search pattern. Rather than looking for one fixed string, a RegEx describes the *shape* of the text you're after, such as "a dollar sign followed by digits and a decimal point" or "whatever appears between two specific tags."

For web scraping, RegEx is most useful in these cases:

- The data has a predictable format (prices, dates, emails, SKUs), but the markup around it doesn't.
- You need one value out of a longer text node and don't want to write complex parsing logic for it.
- Your scraped strings need cleaning or normalizing.

Python's built-in `re` module handles RegEx, so you don't need to install anything extra.

## Common RegEx Tokens

| Token | Meaning | Example | Matches |
|-------|---------|---------|---------|
| `.` | Any character except newline | `a.c` | `abc`, `a1c` |
| `\d` | Any digit (0–9) | `\d\d` | `42` |
| `\w` | Word character (letter, digit, underscore) | `\w+` | `product_1` |
| `\s` | Whitespace | `a\sb` | `a b` |
| `*` | Zero or more of the preceding token | `ab*` | `a`, `abbb` |
| `+` | One or more of the preceding token | `\d+` | `7`, `2024` |
| `?` | Zero or one; also makes quantifiers lazy | `colou?r` | `color`, `colour` |
| `{n,m}` | Between n and m repetitions | `\d{2,4}` | `12`, `1234` |
| `[...]` | Character set | `[A-Z]` | `Q` |
| `^` / `$` | Start / end of string | `^Hi` | `Hi there` |
| `(...)` | Capture group | `(\d+)\.(\d+)` | `19.99` → `19`, `99` |
| `\|` | Alternation (OR) | `cat\|dog` | `cat`, `dog` |
| `\` | Escape special character | `\$` | `$` |

This tutorial relies most on capture groups. A capture group matches the full pattern but hands back only the piece inside the parentheses.

## Step 1: Set Up a Virtual Environment

Make a project folder and give it its own environment so its dependencies don't mix with anything else:

```bash
mkdir regex-scraper
cd regex-scraper
python3 -m venv venv
source venv/bin/activate   # On Windows: venv\Scripts\activate
```

## Step 2: Install Requests and Beautiful Soup

Requests sends the HTTP calls. Beautiful Soup lets you move through the HTML tree to the right spot, and RegEx does the extraction from there:

```bash
pip install requests beautifulsoup4
```

## Step 3: Fetch the Sandbox Products Page

Oxylabs hosts a scraping sandbox at `https://sandbox.oxylabs.io/products` that imitates a real e-commerce catalog. Create a file named `scraper.py` and request the page:

```python
import requests

url = "https://sandbox.oxylabs.io/products"
response = requests.get(url)
response.raise_for_status()

print(response.status_code)
```

If it prints `200`, the request worked.

## Step 4: Isolate the Product Cards

Before applying any RegEx, cut the page down to smaller pieces. With Beautiful Soup, you can pull out each product card as a separate block of HTML:

```python
from bs4 import BeautifulSoup

soup = BeautifulSoup(response.text, "html.parser")
cards = soup.find_all("div", class_="product-card")

print(f"Found {len(cards)} product cards")
```

Processing one card at a time keeps the patterns short and stops a match from spilling over into the next product.

## Step 5: Inspect the Markup

In your browser, right-click a product on the page and choose **Inspect**. The structure will look roughly like this:

```html
<div class="product-card">
  ...
  <h4 class="title css-7u5e79 eag3qlw7">The Legend of Zelda: Ocarina of Time</h4>
  ...
  <div class="price-wrapper css-li4v8k eag3qlw4">91,99 €</div>
  ...
</div>
```

Two details stand out. The class attributes end in auto-generated suffixes that could change later. The price also uses a comma as the decimal separator and puts the currency symbol at the end. Hard-coded selectors handle both of these poorly, which is why RegEx is the better tool here.

## Step 6: Write Capture-Group Patterns

Turn each card into a string, then match it with patterns that key on the fixed start of the class name and skip whatever follows:

```python
import re

title_pattern = re.compile(r'<h4 class="title[^"]*">(.*?)</h4>')
price_pattern = re.compile(r'<div class="price-wrapper[^"]*">\s*([\d.,]+)\s*€?')
```

How the patterns work:

- `class="title[^"]*"` matches `title` plus any run of characters other than a closing quote, so the match survives when the suffixes change.
- `(.*?)` is a lazy capture group: it takes the title text and stops at the first `</h4>`.
- `([\d.,]+)` captures digits, commas, and periods, so it handles formats like `91,99` or `1.299,00`.

Next, run the patterns against each card:

```python
products = []

for card in cards:
    html = str(card)
    title_match = title_pattern.search(html)
    price_match = price_pattern.search(html)

    if title_match and price_match:
        title = title_match.group(1).strip()
        price = price_match.group(1).strip()
        products.append((title, price))
```

## Step 7: Save the Results to a Text File

Write the products to a plain text file, one per line:

```python
with open("products.txt", "w", encoding="utf-8") as f:
    for title, price in products:
        f.write(f"{title}: {price} €\n")

print(f"Saved {len(products)} products to products.txt")
```

## The Full Script

```python
import re
import requests
from bs4 import BeautifulSoup

URL = "https://sandbox.oxylabs.io/products"

title_pattern = re.compile(r'<h4 class="title[^"]*">(.*?)</h4>')
price_pattern = re.compile(r'<div class="price-wrapper[^"]*">\s*([\d.,]+)\s*€?')


def fetch_page(url):
    response = requests.get(url)
    response.raise_for_status()
    return response.text


def parse_products(html):
    soup = BeautifulSoup(html, "html.parser")
    cards = soup.find_all("div", class_="product-card")
    products = []

    for card in cards:
        card_html = str(card)
        title_match = title_pattern.search(card_html)
        price_match = price_pattern.search(card_html)

        if title_match and price_match:
            products.append((
                title_match.group(1).strip(),
                price_match.group(1).strip(),
            ))

    return products


def save_products(products, filename="products.txt"):
    with open(filename, "w", encoding="utf-8") as f:
        for title, price in products:
            f.write(f"{title}: {price} €\n")


if __name__ == "__main__":
    html = fetch_page(URL)
    products = parse_products(html)
    save_products(products)
    print(f"Saved {len(products)} products to products.txt")
```

Run `python scraper.py`, and within seconds you'll have a clean list of titles and prices.

## Next Steps

RegEx is a useful tool for scraping, but larger jobs run into other problems: IP blocks, CAPTCHAs, JavaScript rendering, and site structures that keep changing. Oxylabs' Web Scraper API deals with those problems and returns ready-to-use data even from the most complex targets, leaving you free to concentrate on parsing and analysis. For more practice, see our other tutorials on Python web scraping, headless browsers, and data parsing.
