# Web Scraping with Regular Expressions in Python: A Step-by-Step Tutorial

Web pages are rarely as tidy as we'd like. Markup changes between releases, class names shift, and the data you need is often buried inside inconsistent strings. Regular Expressions (RegEx) give you a precise, flexible way to pull structured data out of that mess. In this tutorial, you'll learn what RegEx is, review the most useful tokens, and build a working Python scraper that extracts product titles and prices from the Oxylabs sandbox.

## What Are Regular Expressions?

A regular expression is a sequence of characters that defines a search pattern. Instead of matching a fixed string, a RegEx describes the *shape* of the text you want: "a dollar sign followed by digits and a decimal point," for example, or "whatever appears between two specific tags."

In web scraping, RegEx is especially useful when:

- The data follows a predictable format (prices, dates, emails, SKUs) but sits inside unpredictable markup.
- You want to extract a value from a larger text node without writing complex parsing logic.
- You need to clean or normalize scraped strings.

Python supports RegEx through the built-in `re` module, so there's nothing extra to install.

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

Capture groups are the star of this tutorial. They let you match a whole pattern but return only the part you care about.

## Step 1: Set Up a Virtual Environment

Create a project folder and an isolated environment so dependencies stay clean:

```bash
mkdir regex-scraper
cd regex-scraper
python3 -m venv venv
source venv/bin/activate   # On Windows: venv\Scripts\activate
```

## Step 2: Install Requests and Beautiful Soup

Requests handles HTTP calls, and Beautiful Soup helps you navigate the HTML tree before RegEx takes over:

```bash
pip install requests beautifulsoup4
```

## Step 3: Fetch the Sandbox Products Page

Oxylabs provides a scraping sandbox at `https://sandbox.oxylabs.io/products` that mimics a real e-commerce catalog. Create a file called `scraper.py` and fetch the page:

```python
import requests

url = "https://sandbox.oxylabs.io/products"
response = requests.get(url)
response.raise_for_status()

print(response.status_code)
```

A `200` status code means you're good to go.

## Step 4: Isolate the Product Cards

Rather than running RegEx across the entire page, narrow the scope first. Beautiful Soup lets you grab each product card as its own chunk of HTML:

```python
from bs4 import BeautifulSoup

soup = BeautifulSoup(response.text, "html.parser")
cards = soup.find_all("div", class_="product-card")

print(f"Found {len(cards)} product cards")
```

Working card by card keeps your patterns simple and prevents matches from bleeding across products.

## Step 5: Inspect the Markup

Open the page in your browser, right-click a product, and choose **Inspect**. You'll see a structure similar to this:

```html
<div class="product-card">
  ...
  <h4 class="title css-7u5e79 eag3qlw7">The Legend of Zelda: Ocarina of Time</h4>
  ...
  <div class="price-wrapper css-li4v8k eag3qlw4">91,99 €</div>
  ...
</div>
```

Notice two things. First, the class attributes contain auto-generated suffixes that may change over time. Second, the price uses a comma as a decimal separator and a trailing currency symbol. Both are good reasons to reach for RegEx instead of hard-coded selectors.

## Step 6: Write Capture-Group Patterns

Convert each card to a string and apply patterns that anchor on the stable part of the class name while ignoring the rest:

```python
import re

title_pattern = re.compile(r'<h4 class="title[^"]*">(.*?)</h4>')
price_pattern = re.compile(r'<div class="price-wrapper[^"]*">\s*([\d.,]+)\s*€?')
```

Here's what's happening:

- `class="title[^"]*"` matches `title` followed by any characters that aren't a closing quote, so changing suffixes don't break the match.
- `(.*?)` is a lazy capture group that grabs the title text and stops at the first `</h4>`.
- `([\d.,]+)` captures digits, commas, and periods, which covers formats like `91,99` or `1.299,00`.

Now apply them:

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

Write each product to a line in a plain text file:

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

Run it with `python scraper.py`, and you'll have a clean list of titles and prices in seconds.

## Next Steps

RegEx is a powerful addition to your scraping toolkit, but scaling up brings new challenges: IP blocks, CAPTCHAs, JavaScript rendering, and constantly shifting site structures. Oxylabs' Web Scraper API handles those hurdles for you, returning ready-to-use data from even the most complex targets so you can focus on parsing and analysis. To keep building your skills, explore our other tutorials on Python web scraping, headless browsers, and data parsing.
