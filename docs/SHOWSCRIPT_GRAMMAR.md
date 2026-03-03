# ShowScript Grammar Specification

**Version:** 0.3.3-draft  
**Status:** Design Phase  
**Target:** Compiles to ShowRun JSON-DSL

ShowScript is a concise language for browser automation that compiles to ShowRun's JSON-DSL.

---

## Design Principles

1. **Familiarity** — Syntax familiar to AI agents and developers
2. **Conciseness** — Reduce boilerplate, make common patterns short
3. **Readability** — Human-stable selectors, clear intent
4. **Compilable** — 1:1 mapping to JSON-DSL (no runtime changes)
5. **Extensible** — Easy to add new step types
6. **Explicit Structure** — Braces for control flow, no forced indentation

---

## File Structure

```showscript
# Comments start with #

# Metadata block (optional)
meta:
    id: "my-taskpack"
    name: "My Task Pack"
    version: "1.0.0"
    description: "Does something useful"

# Input declarations
inputs:
    username: string                          # required, no default
    password: secret                          # required, marked as sensitive
    batch: string = "Winter 2024"             # optional with default
    max_results: number = 100                 # number type
    headless: bool = true                     # boolean type

# Output declarations (collectibles)
outputs:
    page_title: string
    companies: array
    raw_data: object

# Main flow
flow:
    goto("https://example.com")
    # steps go here...
```

---

## Lexical Elements

### Comments
```showscript
# Single line comment
```

### Identifiers
```
[a-zA-Z_][a-zA-Z0-9_]*
```
Note: Reserved words cannot be used as identifiers (see Reserved Words section).

### Literals

```showscript
# Strings
"double quoted"
'single quoted'
f"interpolated {variable} string"
f'single-quoted interpolated {variable}'
f"with filters {batch | urlencode}"
r"regex pattern \d+"                  # raw string (no escape processing)
r'single-quoted raw string \d+'

# Numbers
42
3.14
-10

# Booleans
true
false

# Duration literals
5s          # 5000ms
100ms       # 100ms
1m          # 60000ms
1.5s        # 1500ms

# Null
null
```

> **Disambiguation:** Duration suffixes are greedy — `5` is a NUMBER, but `5s` is a duration literal. The lexer consumes the suffix if present.

### String Escape Sequences

Normal strings support standard escape sequences:
- `\n` — newline
- `\t` — tab
- `\\` — backslash
- `\"` — double quote
- `\'` — single quote

```showscript
"line1\nline2"                       # newline between lines
"path\\to\\file"                     # escaped backslashes
"say \"hello\""                      # escaped quotes
```

Raw strings (`r"..."` or `r'...'`) disable escape processing, making them ideal for regex patterns:
```showscript
r"/users/\d+"                        # \d stays as literal \d
r"C:\Users\name"                     # no need to escape backslashes
r'also works with single quotes'
```

### String Interpolation

Inside f-strings (double or single quoted):
```showscript
f"Hello {name}"                       # simple variable
f'Hello {name}'                       # single-quoted f-string
f"URL: {url | urlencode}"             # with filter
f"Page {page | default: 1}"           # with filter argument
f"Items: {items | join: ', '}"        # filter with argument
```

**Built-in filters (via Nunjucks):**
- `urlencode` — URL encode the value
- `pctEncode` — Aggressive URL encode (also encodes `! ' ( ) * ~`)
- `lower` / `upper` — case conversion
- `trim` — strip whitespace
- `default: value` — fallback if empty/null
- `join: separator` — join array elements
- `totp` — generate TOTP code from base32 secret

---

## Built-in Variables

These variables are available throughout your flow:

| Variable   | Description                              |
|------------|------------------------------------------|
| `url`      | Current page URL                         |
| `method`   | HTTP method of the current/captured request |
| `status`   | HTTP status code of the current/captured response |
| `response` | Response body of the current/captured request |

> **Note on Shadowing:** These built-in names (`url`, `method`, `status`, `response`) are **not reserved words** — they can be shadowed by local variable assignments. However, shadowing is **discouraged** as it can lead to confusion about which value is being referenced.

```showscript
# Use in conditions
if (contains(url, "/dashboard")) {
    # on dashboard page
}

# Use in network conditions
api_req = network.find(
    conditions: [
        contains(url, "api.example.com"),
        equals(method, "POST"),
        equals(status, 200)
    ],
    wait: 10s
)

# Shadowing (allowed but discouraged)
url = "https://override.com"         # now url refers to this, not page URL
```

---

## Built-in Functions

### Comparison Functions

These functions return boolean values and are used in conditions:

| Function | Description | Example |
|----------|-------------|---------|
| `contains(haystack, needle)` | Check if string/array contains value | `contains(url, "/api")` |
| `equals(a, b)` | Check if two values are equal | `equals(status, 200)` |
| `matches(value, regex)` | Check if value matches regex pattern | `matches(url, r"/users/\d+")` |

```showscript
# In conditionals
if (contains(url, "/dashboard")) {
    click(@css(".dashboard-item"))
}

# In assertions
assert(equals(status, 200), message: "Expected 200 OK")

# In network.find conditions
api_req = network.find(
    conditions: [
        contains(url, "api.example.com"),
        matches(url, r"/v\d+/"),
        equals(method, "POST")
    ],
    wait: 10s
)
```

### Utility Functions

| Function | Description | Example |
|----------|-------------|---------|
| `len(value)` | Returns length of array or string | `len(items)` |
| `title()` | Returns the current page title | `page_title = title()` |

```showscript
# Check array length
if (len(items) > 0) {
    # process items
}

# Get page title
page_title = title()

# Use in expressions
total_fetched = total_fetched + len(batch_items)
```

---

## Target Selectors

Targets identify DOM elements using the `@` prefix. They compile to the JSON `Target` type.

### Basic Targets

```showscript
@css(".my-class")                        # CSS selector
@css("div.container > p:first-child")

@text("Click me")                        # Text content (contains)
@text("Click me", exact: true)           # Exact match

@role("button")                          # ARIA role
@role("button", "Submit")                # Role + accessible name
@role("textbox", "Email", exact: true)   # Role + exact name match

@label("Email Address")                  # Associated label text
@label("Email", exact: true)

@attr("disabled")                        # Attribute existence check
@attr("data-loading")                    # Check for presence only
@attr("required")

@attr("data-testid", "submit-btn")       # Attribute value equality
@attr("placeholder", "Enter your email")
@attr("alt", "Profile picture")
@attr("href", "/dashboard")
```

> **`@attr` Semantics:**
> - **1 argument:** `@attr("name")` — checks if the attribute *exists* (any value, including empty string)
> - **2 arguments:** `@attr("name", "value")` — checks if the attribute *equals* the specified value

### Target Modifiers

```showscript
# Scope: search within a container
@css(".item").in(@css(".container"))
@role("button", "Save").in(@css("form.settings"))

# Near: spatial proximity hint (for Teach Mode)
@role("textbox").near(@text("Username"))

# Combined
@css("input").in(@css(".login-form")).near(@text("Password"))

# Fallback: try multiple selectors
@any(
    @css("#main-button"),
    @role("button", "Submit"),
    @text("Submit")
)
```

---

## Step Types

### Navigation

```showscript
# Basic navigation
goto("https://example.com")
goto(f"https://example.com/search?q={query | urlencode}")

# With wait condition
goto("https://example.com", wait: "networkidle")
goto("https://example.com", wait: "domcontentloaded")
goto("https://example.com", wait: "load")
goto("https://example.com", wait: "commit")
```

### Waiting

```showscript
# Wait for element (visible by default)
wait(@css(".loaded"))
wait(@css(".loaded"), visible: true)
wait(@css(".loaded"), visible: false)        # wait for exists only
wait(@role("button", "Continue"))

# Wait for URL condition
wait(contains(url, "/dashboard"))
wait(matches(url, r"/users/\d+"))

# Wait for load state
wait(networkidle)
wait(domcontentloaded)
wait(load)

# With timeout
wait(@css(".slow-element"), timeout: 10s)
```

> **`wait()` Forms:**
> - **`wait(target)`** — wait for element to be visible (e.g., `wait(@css(".loaded"))`)
> - **`wait(load_state)`** — wait for page load state: `networkidle`, `domcontentloaded`, or `load`
> - **`wait(condition)`** — wait for a condition to become true (e.g., `wait(contains(url, "/dashboard"))`)

### Clicking

```showscript
# Basic click
click(@css(".button"))
click(@role("button", "Submit"))
click(@text("Sign In"))

# Options
click(@css(".button"), first: true)          # first match (default)
click(@css(".item"), all: true)              # click all matches
click(@css(".button"), wait: false)          # don't wait for visible
```

### Typing / Filling

```showscript
# Fill input
fill(@css("input[name='email']"), "user@example.com")
fill(@role("textbox", "Email"), f"{username}@example.com")
fill(@label("Password"), password)           # reference to input variable

# Options
fill(@css("input"), "text", clear: false)    # don't clear first

# Press keys
press("Enter")
press("Tab")
press("Control+a")
press("ArrowDown", times: 3)
press("ArrowDown", times: 3, delay: 100ms)

# Press on specific element
press("Enter", on: @css("input.search"))
press("Escape", on: @role("dialog"))
```

### Extraction (Deprecated — use scrape instead)

> **Note:** Standalone extraction steps are deprecated. Use `scrape()` for all extraction needs.
> These are supported for backwards compatibility but may be removed in future versions.

```showscript
# Extract page title (still supported - no element needed)
page_title = title()

# Deprecated extraction (use scrape instead)
# heading = text(@css("h1"))               # deprecated
# link = attr(@css("a.main"), "href")      # deprecated
```

### DOM Scraping (Structured Data)

```showscript
# Extract array of objects from repeating elements
products = scrape(@css(".product-card"), {
    name: text(@css(".product-name")),
    price: text(@css(".price")),
    url: attr(@css("a"), "href"),
    image: attr(@css("img"), "src"),
})

# Single element extraction (use first: true)
product = scrape(@css(".product-card"), {
    name: text(@css(".product-name")),
    price: text(@css(".price")),
}, first: true)

# Skip empty rows (default: true)
products = scrape(@css(".product-card"), {
    name: text(@css(".name")),
    price: text(@css(".price")),
}, skip_empty: false)
```

**Options:**
- `first: true` — Returns a single object instead of an array (first matching element only)
- `skip_empty: false` — Include rows where all extractions are empty (default: skip them)

**Field values:** Can be any expression — extraction functions (`text()`, `attr()`), literals, or variables:
```showscript
products = scrape(@css(".product-card"), {
    name: text(@css(".name")),
    source: "shop1",                        # literal string
    batch: current_batch,                   # variable
})
```

> **Static Keys Only:** Object keys in `scrape()` and object literals must be identifiers. Computed/dynamic keys (e.g., `{[keyVar]: value}`) are not supported.

### Assertions

```showscript
# Assert element exists
assert(@css(".success-message"))
assert(@role("alert"))

# Assert visibility
assert(@css(".modal"), visible: true)
assert(@css(".loading"), visible: false)

# Assert text content
assert(@css("h1"), contains: "Welcome")
assert(@css(".status"), equals: "Active")

# Assert using built-in comparison functions
assert(contains(url, "/dashboard"))
assert(equals(url, "https://example.com/home"))
assert(matches(url, r"/users/\d+"))

# Custom error message
assert(@css(".logged-in"), message: "User should be logged in")
```

### Network Operations

```showscript
# Find a network request using conditions
api_req = network.find(
    conditions: [
        contains(url, "api.example.com"),
        equals(method, "POST"),
        equals(status, 200),
        contains(response, "success"),
    ],
    wait: 10s
)

# Replay with modifications
result = network.replay(api_req, {
    auth: "browser",
    url_replace: [r"/page/\d+", f"/page/{next_page}"],
    body_replace: ["limit=10", f"limit={limit}"],
    query_set: { page: page_num, limit: 50 },
    headers_set: { "X-Custom": "value" },
    response: "json",
})

# Extract from response (JMESPath syntax)
items = extract(result, path: "data.items[*].{id, name, status}")
total = extract(result, path: "meta.total")

# Extract as text
raw = extract(result, as: "text")
```

### Select / Dropdown

```showscript
# Select by value
select(@css("select.country"), value: "US")

# Select by visible text
select(@css("select.country"), label: "United States")

# Select by index
select(@css("select.country"), index: 0)

# Multi-select
select(@css("select.tags"), values: ["tag1", "tag2", "tag3"])
```

### File Upload

```showscript
upload(@css("input[type='file']"), "./document.pdf")
upload(@css("input[type='file']"), ["./doc1.pdf", "./doc2.pdf"])
```

### Frames / Iframes

```showscript
# Enter iframe
frame.enter(@css("iframe.content"))
frame.enter(name: "editor-frame")
frame.enter(url: "editor.example.com")

# ... do stuff inside frame ...

# Exit back to main
frame.exit()
```

### Tabs

```showscript
# Open new tab
new_tab()
new_tab("https://example.com")
tab_index = new_tab("https://example.com")

# Switch tabs
switch_tab(0)                                # by index
switch_tab("last")                           # last opened
switch_tab("previous")                       # previous tab

# Close current and switch
switch_tab("last", close_current: true)
```

### Sleep (discouraged)

```showscript
# Prefer wait steps, but available when needed
sleep(2s)
sleep(500ms)
```

---

## Control Flow

### Conditionals

```showscript
# Basic if
if (@css(".cookie-banner").visible) {
    click(@css(".cookie-accept"))
}

# If-else
if (@css(".logged-in").visible) {
    goto("https://example.com/dashboard")
} else {
    goto("https://example.com/login")
}

# If-elif-else
if (@css(".cookie-modal").visible) {
    click(@role("button", "Accept All"))
} elif (@css(".gdpr-banner").visible) {
    click(@css(".gdpr-accept"))
} else {
    # No popup, continue
}

# Negation
if (!@css(".element").visible) {
    # element is not visible
}

# Empty blocks are allowed
if (@css(".optional").visible) {
    # nothing to do here
}
```

### Condition Types

```showscript
# Element conditions
@css(".element").visible              # element is visible
@css(".element").exists               # element exists in DOM
!@css(".element").visible             # element is NOT visible

# Using built-in comparison functions
contains(url, "/dashboard")
equals(status, 200)
matches(url, r"/users/\d+")

# Variable conditions
logged_in                             # truthy check
!logged_in                            # falsy check
page > 0
page == max_pages
retry_count < 3

# Compound conditions
logged_in && verified
retry < 3 || force_retry

# Collection conditions
result.empty                          # array/object is empty
!result.empty                         # not empty
```

### Loops as Expressions

Loops in ShowScript are expressions that return an array of yielded values. Use the `yield` keyword to collect values from each iteration.

#### For Loops

```showscript
# For loop as expression — collects all yielded values
all_items = for (page in range(1, 10)) {
    goto(f"https://example.com/page/{page}")
    items = scrape(@css(".item"), { name: text(@css(".name")) })
    yield items
}

# For loop over extracted data
company_details = for (company in companies) {
    goto(f"https://example.com/company/{company.slug}")
    details = scrape(@css(".details"), {
        name: company.name,
        description: text(@css(".desc")),
        employees: text(@css(".emp-count")),
    })
    yield details
}

# No yield = fire-and-forget loop (result discarded)
for (i in range(1, 5)) {
    click(@css(".next"))
    wait(networkidle)
}
```

#### While Loops

```showscript
# While loop as expression
page = 1
results = while (page <= max_pages) {
    items = scrape(@css(".item"), {
        name: text(@css(".name")),
        price: text(@css(".price")),
    })
    page = page + 1
    
    if (@css(".next-page").visible) {
        click(@css(".next-page"))
        wait(networkidle)
        yield items
    } else {
        yield items
        # Exit by setting page beyond max
        page = max_pages + 1
    }
}
```

#### Nested Loops

Each loop has its own result array. Inner loops must be assigned to a variable to capture their results:

```showscript
# Nested loops — inner must be assigned to capture
all_data = for (category in categories) {
    # Inner loop assigned to variable
    items = for (page in range(1, 5)) {
        goto(f"/category/{category.id}/page/{page}")
        yield scrape(@css(".item"), { name: text(@css(".name")) })
    }
    yield { category: category.name, items: items }
}
```

### Step Options

```showscript
# Optional step (won't fail the flow)
click(@css(".optional-popup"), optional: true)

# Custom timeout
wait(@css(".slow-thing"), timeout: 30s)

# Continue on error (don't stop flow)
click(@css(".might-not-exist"), on_error: "continue")

# Run once per session
click(@css(".first-time-modal button"), once: "session")

# Run once per profile
fill(@css(".remember-me"), "yes", once: "profile")

# Label for logging/debugging
goto("https://example.com", label: "Navigate to homepage")
```

---

## Operators

### Arithmetic Operators

| Operator | Description |
|----------|-------------|
| `+` | Addition |
| `-` | Subtraction (binary) |
| `*` | Multiplication |
| `/` | Division |
| `%` | Modulo (remainder) |

### Comparison Operators

| Operator | Description |
|----------|-------------|
| `==` | Equal |
| `!=` | Not equal |
| `>` | Greater than |
| `<` | Less than |
| `>=` | Greater than or equal |
| `<=` | Less than or equal |

### Logical Operators

| Operator | Description |
|----------|-------------|
| `&&` | Logical AND |
| `\|\|` | Logical OR |
| `!` | Logical NOT (unary) |

### Unary Operators

| Operator | Description |
|----------|-------------|
| `-` | Arithmetic negation |
| `!` | Logical NOT |

### Operator Precedence

From highest to lowest:
1. `!`, `-` (unary) — unary operators
2. `*`, `/`, `%` — multiplicative
3. `+`, `-` (binary) — additive
4. `==`, `!=`, `>`, `<`, `>=`, `<=` — comparison
5. `&&` — logical AND
6. `||` — logical OR

Use parentheses for explicit grouping:
```showscript
result = (a + b) * c
is_valid = (page > 0) && (page <= max_pages)
should_retry = !success && (attempts < max_retries)
```

---

## Disambiguation Notes

This section clarifies potentially ambiguous syntax for parser implementers.

### Step Call vs Property Access

When parsing an identifier followed by `(`, it's a **step call**. Otherwise, it's a **property access**:

```showscript
network.find(...)              # step_call — has parentheses
company.name                   # property_access — no parentheses
```

> **Parser Lookahead:** Distinguishing `property_access` from `step_call` requires lookahead — the parser must scan past the `.IDENT` chain to check for `(`. PEG/packrat parsers handle this naturally via backtracking. Hand-written parsers may need multiple passes or explicit lookahead logic.

### Duration vs Number

Duration suffixes are **greedy** — the lexer consumes the suffix if present:

```showscript
5                              # NUMBER (integer 5)
5s                             # duration (5000ms)
5.5                            # NUMBER (float 5.5)
5.5s                           # duration (5500ms)
```

---

## Complete Examples

### Example 1: Simple Page Scrape

**ShowScript:**
```showscript
inputs:
    url: string

outputs:
    page_title: string
    products: array

flow:
    goto(url, wait: "networkidle")
    wait(@css(".products"), timeout: 5s)
    
    page_title = title()
    
    products = scrape(@css(".product-card"), {
        name: text(@css(".product-name")),
        price: text(@css(".price")),
        url: attr(@css("a"), "href"),
    })
```

**Compiles to JSON-DSL:**
```json
{
  "inputs": {
    "url": { "type": "string", "required": true }
  },
  "collectibles": [
    { "name": "page_title", "type": "string" },
    { "name": "products", "type": "array" }
  ],
  "flow": [
    {
      "id": "step_1",
      "type": "navigate",
      "params": { "url": "{{inputs.url}}", "waitUntil": "networkidle" }
    },
    {
      "id": "step_2",
      "type": "wait_for",
      "params": { 
        "target": { "kind": "css", "selector": ".products" }, 
        "visible": true, 
        "timeoutMs": 5000 
      }
    },
    {
      "id": "step_3",
      "type": "extract_title",
      "params": { "out": "page_title" }
    },
    {
      "id": "step_4",
      "type": "dom_scrape",
      "params": {
        "target": { "kind": "css", "selector": ".product-card" },
        "collect": [
          { "key": "name", "target": { "kind": "css", "selector": ".product-name" }, "extract": "text" },
          { "key": "price", "target": { "kind": "css", "selector": ".price" }, "extract": "text" },
          { "key": "url", "target": { "kind": "css", "selector": "a" }, "extract": "attribute", "attribute": "href" }
        ],
        "out": "products"
      }
    }
  ]
}
```

### Example 2: Login with Cookie Handling

**ShowScript:**
```showscript
inputs:
    username: string
    password: secret

outputs:
    logged_in: bool

flow:
    goto("https://example.com/login")
    
    # Handle cookie banner if present
    if (@css(".cookie-banner").visible) {
        click(@css(".cookie-accept"))
    }
    
    fill(@label("Email"), username)
    fill(@label("Password"), password)
    click(@role("button", "Sign In"))
    
    wait(contains(url, "/dashboard"), timeout: 10s)
    logged_in = true
    
    assert(@css(".user-menu"), visible: true, message: "Login failed")
```

### Example 3: Pagination with Network Replay

**ShowScript:**
```showscript
meta:
    id: "yc-batch-companies"
    name: "YC Batch Company Collector"
    version: "1.0.0"

inputs:
    batch: string = "Winter 2024"
    max_results: number = 1000

outputs:
    companies: array

flow:
    goto(f"https://www.ycombinator.com/companies?batch={batch | urlencode}")
    
    # Capture initial API request
    api_req = network.find(
        conditions: [
            contains(url, "algolia"),
            equals(method, "POST"),
            contains(response, "hits"),
        ],
        wait: 10s
    )
    
    page = 0
    total_fetched = 0
    
    # Loop as expression with yield
    companies = while (total_fetched < max_results) {
        result = network.replay(api_req, {
            auth: "browser",
            body_replace: [r'"page":\d+', f'"page":{page}'],
            response: "json",
        })
        
        batch_companies = extract(result, path: "results[0].hits[*]")
        
        if (batch_companies.empty) {
            # Exit loop by setting total beyond max
            total_fetched = max_results + 1
        } else {
            total_fetched = total_fetched + len(batch_companies)
            page = page + 1
            yield batch_companies
        }
    }
```

### Example 4: Multi-Tab Price Comparison

**ShowScript:**
```showscript
inputs:
    product_name: string

outputs:
    prices: array

flow:
    # Search on site 1
    goto("https://shop1.com")
    fill(@css("input.search"), product_name)
    press("Enter")
    wait(@css(".results"))
    
    price1 = scrape(@css(".product-card"), {
        price: text(@css(".price")),
        name: text(@css(".name")),
        source: "shop1",
    }, first: true)
    
    # Open site 2 in new tab
    new_tab("https://shop2.com")
    fill(@css("#search"), product_name)
    press("Enter")
    wait(@css(".products"))
    
    price2 = scrape(@css(".item"), {
        price: text(@css(".cost")),
        name: text(@css(".title")),
        source: "shop2",
    }, first: true)
    
    # Combine results
    prices = [price1, price2]
    
    # Back to first tab
    switch_tab(0)
```

### Example 5: Retry Pattern

**ShowScript:**
```showscript
inputs:
    url: string
    max_retries: number = 3

outputs:
    content: array

flow:
    attempts = 0
    success = false
    
    while (attempts < max_retries && !success) {
        goto(url)
        
        if (@css(".rate-limit").visible) {
            attempts = attempts + 1
            sleep(5s)
        } elif (@css(".content").visible) {
            content = scrape(@css(".content"), {
                text: text(@css("p")),
            })
            success = true
        } else {
            attempts = attempts + 1
        }
    }
    
    assert(success, message: "Failed after max retries")
```

---

## Reserved Words

The following words are reserved and cannot be used as identifiers:

```
if, elif, else, while, for, in, yield, range,
true, false, null,
meta, inputs, outputs, flow
```

---

## Formal Grammar (EBNF)

```ebnf
(* Top level *)
program         = { block_section } ;
block_section   = meta_block | inputs_block | outputs_block | flow_block ;

(* Metadata - colon + newline-separated fields *)
meta_block      = "meta" ":" NEWLINE { meta_field } ;
meta_field      = IDENT ":" literal NEWLINE ;

(* Inputs/Outputs - colon + newline-separated declarations *)
inputs_block    = "inputs" ":" NEWLINE { input_decl } ;
input_decl      = IDENT ":" type_spec [ "=" expression ] NEWLINE ;
(* Note: Input default values can be any expression (e.g., -10, 5 + 3, MAX_RETRIES).
   Semantic analysis may restrict which expressions are valid for defaults
   (typically compile-time constant expressions). *)
type_spec       = "string" | "number" | "bool" | "secret" | "array" | "object" ;

outputs_block   = "outputs" ":" NEWLINE { output_decl } ;
output_decl     = IDENT ":" type_spec NEWLINE ;

(* Flow - colon then statements *)
flow_block      = "flow" ":" NEWLINE { statement } ;
statement       = step_stmt | assign_stmt | control_stmt | yield_stmt ;

(* Assignment *)
assign_stmt     = IDENT "=" expression NEWLINE ;

(* Yield statement *)
yield_stmt      = "yield" expression NEWLINE ;

(* Steps - function call syntax with dotted identifiers *)
step_stmt       = step_call NEWLINE ;
step_call       = IDENT { "." IDENT } "(" [ arg_list ] ")" ;
arg_list        = arg { "," arg } [ "," ] ;   (* trailing comma allowed *)
arg             = expression | named_arg ;
named_arg       = IDENT ":" expression ;

(* Control flow - braces *)
control_stmt    = if_stmt | while_stmt | for_stmt ;

if_stmt         = "if" "(" condition ")" block
                  { "elif" "(" condition ")" block }
                  [ "else" block ] ;

while_stmt      = [ IDENT "=" ] "while" "(" condition ")" block ;

for_stmt        = [ IDENT "=" ] "for" "(" IDENT "in" iterable ")" block ;
iterable        = "range" "(" expression "," expression ")"
                | IDENT ;

block           = "{" { statement } "}" ;   (* empty blocks allowed *)

(* Conditions — same as expressions, evaluated for truthiness *)
condition       = expression ;

(* Property access *)
property_access = IDENT { "." IDENT } ;

(* Target expressions - @ prefix *)
target_expr     = target_primary { target_modifier } ;
target_primary  = "@" target_type "(" arg_list ")"
                | "@any" "(" target_expr { "," target_expr } [ "," ] ")" ;
target_type     = "css" | "text" | "role" | "label" | "attr" ;
target_modifier = "." "in" "(" target_expr ")"
                | "." "near" "(" target_expr ")" ;

(* Expressions - precedence from lowest to highest *)
expression      = or_expr ;

or_expr         = and_expr { "||" and_expr } ;
and_expr        = comparison_expr { "&&" comparison_expr } ;
comparison_expr = additive_expr [ compare_op additive_expr ] ;
additive_expr   = multiplicative_expr { ( "+" | "-" ) multiplicative_expr } ;
multiplicative_expr = unary_expr { ( "*" | "/" | "%" ) unary_expr } ;
unary_expr      = "-" unary_expr
                | "!" unary_expr
                | primary_expr ;

primary_expr    = literal
                | property_access
                | string_expr
                | target_expr
                | step_call
                | extraction_expr
                | loop_expr
                | "(" expression ")" ;

compare_op      = "==" | "!=" | ">" | "<" | ">=" | "<=" ;

(* Loop expressions *)
loop_expr       = while_stmt | for_stmt ;

string_expr     = string_literal | f_string | r_string ;
string_literal  = '"' { CHAR | escape_seq } '"' | "'" { CHAR | escape_seq } "'" ;
escape_seq      = "\\" ( "n" | "t" | "\\" | '"' | "'" ) ;
f_string        = 'f"' { CHAR | escape_seq | interpolation } '"'
                | "f'" { CHAR | escape_seq | interpolation } "'" ;
r_string        = 'r"' { CHAR } '"'
                | "r'" { CHAR } "'" ;
interpolation   = "{" IDENT { "|" filter } "}" ;
filter          = IDENT [ ":" literal ] ;

(* Object literal - static keys only (identifiers) *)
object_literal  = "{" [ object_field { "," object_field } [ "," ] ] "}" ;
object_field    = IDENT ":" expression ;

(* Array literal *)
array_literal   = "[" [ expression { "," expression } [ "," ] ] "]" ;

(* Extraction expressions - valid in object field values and standalone *)
extraction_expr = "text" "(" target_expr ")" 
                | "attr" "(" target_expr "," string_expr ")" ;

(* Literals - note: strings handled via string_expr in expression *)
literal         = NUMBER | BOOL | "null" | string_literal | array_literal | object_literal | duration ;
duration        = NUMBER ( "s" | "ms" | "m" ) ;

(* Reserved words *)
reserved        = "if" | "elif" | "else" | "while" | "for" | "in" | "yield" | "range"
                | "true" | "false" | "null"
                | "meta" | "inputs" | "outputs" | "flow" ;

(* Tokens *)
IDENT           = /[a-zA-Z_][a-zA-Z0-9_]*/ - reserved ;
NUMBER          = /\d+(\.\d+)?/ ;
BOOL            = "true" | "false" ;
NEWLINE         = /\n/ ;
CHAR            = (* any character except unescaped quote *) ;
```

---

## File Extension

`.showscript` or `.ss`

---

## Implementation Notes

### Parser Strategy

1. **Lexer** — Tokenize (no significant whitespace except in block sections)
2. **Parser** — Recursive descent or PEG parser
3. **AST** — Build abstract syntax tree
4. **Compiler** — Walk AST, emit JSON-DSL

### Recommended Tools

- **TypeScript:** Use a PEG parser like `peggy` (successor to PEG.js)
- **Error messages:** Source maps for good error locations

### Integration

```bash
# Compile .showscript to flow.json
showrun compile ./my-flow.showscript -o ./taskpack/flow.json

# Or auto-detect in taskpack
showrun run ./taskpack  # auto-compiles if flow.showscript exists
```

---

## Changelog

- **0.3.3-draft** — Grammar review round 4 fixes
  - **EBNF fixes:**
    - `input_decl` now allows `expression` as default value (instead of just `literal`), enabling `-10`, `5 + 3`, or any valid expression as defaults
    - Made `unary_expr` recursive to support chained unary operators (`--x`, `!!flag`, `- - 10`)
  - **Documentation:**
    - Added note clarifying that input default values can be any expression, but semantic analysis may restrict which expressions are valid (typically compile-time constants)
    - `meta_field` remains `literal` only — meta values should be static
- **0.3.2-draft** — Grammar review round 3 fixes
  - **EBNF fixes:**
    - Added `string_literal` back to `literal` production (f-strings and r-strings remain expression-only via `string_expr`)
    - Removed negative sign from `NUMBER` token — unary `-` in expressions handles negation
    - Object keys now IDENT only (removed string literal option from `object_field`)
  - **Documentation:**
    - Updated "Static Keys Only" note to reflect IDENT-only keys
    - Added parser lookahead note for `property_access` vs `step_call` disambiguation
- **0.3.1-draft** — EBNF fixes and documentation improvements
  - **EBNF fixes:**
    - Added `extraction_expr` to `primary_expr` in expression grammar
    - Added comparison operators (`==`, `!=`, `>`, `<`, `>=`, `<=`) as part of expression grammar
    - Added logical operators (`&&`, `||`) as binary operators in expressions
    - Added unary operators (`!`, `-`) with `unary_expr` production
    - Restructured expression grammar with proper precedence levels (unary > multiplicative > additive > comparison > AND > OR)
    - Moved `object_literal` INTO `literal` production
    - Removed `string_literal` from `literal` — strings handled via `string_expr` in expression
    - Simplified `condition` to just be `expression` (evaluated for truthiness)
  - **f-strings and r-strings:**
    - Added support for single-quoted f-strings: `f'...'`
    - Added support for single-quoted r-strings: `r'...'`
  - **Documentation additions:**
    - Added note about built-in variable shadowing (`url`, `method`, `status`, `response`)
    - Added "Disambiguation Notes" section explaining step_call vs property_access and duration lexing
    - Documented `@attr` semantics (1 arg = existence, 2 args = value equality)
    - Documented `wait()` forms (element, load_state, condition)
    - Documented static object keys only (no computed keys)
    - Added Comparison Operators and Logical Operators tables
    - Added Unary Operators table
- **0.3.0-draft** — Language refinements based on grammar review
  - **Loops as expressions:** Loops return arrays of yielded values; added `yield` keyword
  - **Generic comparison built-ins:** Added `contains()`, `equals()`, `matches()` functions
  - **Built-in variables:** Documented `url`, `method`, `status`, `response`
  - **Built-in functions:** Added section documenting `len()`, `title()`, and comparison functions
  - **Removed `set()`:** Use assignment syntax everywhere (`page = 1`)
  - **Removed `break`/`continue`:** Use proper control flow with conditions and `yield`
  - **Removed `append()`:** Use `yield` in loops instead
  - **EBNF updates:**
    - Dotted step calls: `network.find()`, `frame.enter()` now supported
    - Property access: `company.slug`, `result.empty`
    - Trailing commas allowed in `arg_list`, `object_literal`, `array_literal`
    - Added `%` (modulo) operator
    - Added `yield_stmt` and `loop_expr` productions
    - Added `extraction_expr` for scrape field values
    - Added `reserved` words production
  - **`network.find` redesign:** Uses `conditions` list with comparison functions
  - **Documentation:**
    - String escape sequences (`\n`, `\t`, `\\`, `\"`)
    - Raw strings disable escape processing
    - Operator precedence rules
    - Empty blocks explicitly allowed
    - `scrape()` options: `first: true`, `skip_empty`
- **0.2.0-draft** — Major syntax revision
  - Changed from Python-like indentation to brace-based control flow
  - Added `@` prefix for target selectors
  - Changed `none` to `null`
  - Added proper `if/elif/else` and `while/for` control flow (replaces `skip_if`)
  - Added `pctEncode` and `totp` filters
  - Deprecated standalone extraction steps (use `scrape` instead)
  - Block sections (meta/inputs/outputs/flow) keep colon syntax
- **0.1.0-draft** — Initial grammar design
