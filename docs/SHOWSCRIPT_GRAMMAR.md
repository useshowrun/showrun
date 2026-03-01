# ShowScript Grammar Specification

**Version:** 0.1.0-draft  
**Status:** Design Phase  
**Target:** Compiles to ShowRun JSON-DSL

ShowScript is a concise, Python-like language for browser automation that compiles to ShowRun's JSON-DSL.

---

## Design Principles

1. **Familiarity** — Python-like syntax that AI agents already know
2. **Conciseness** — Reduce boilerplate, make common patterns short
3. **Readability** — Human-stable selectors, clear intent
4. **Compilable** — 1:1 mapping to JSON-DSL (no runtime changes)
5. **Extensible** — Easy to add new step types

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
    # steps go here
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

### Literals

```showscript
# Strings
"double quoted"
'single quoted'
f"interpolated {variable} string"
f"with filters {batch | urlencode}"

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

# None/null
none
```

### String Interpolation

Inside f-strings:
```showscript
f"Hello {name}"                    # simple variable
f"URL: {url | urlencode}"          # with filter
f"Page {page | default: 1}"        # with filter argument
f"Items: {items | join: ', '}"     # filter with argument
```

**Built-in filters:**
- `urlencode` — URL encode the value
- `lower` / `upper` — case conversion
- `trim` — strip whitespace
- `default: value` — fallback if empty/null
- `join: separator` — join array elements

---

## Target Selectors

Targets identify DOM elements. They compile to the JSON `Target` type.

### Basic Targets

```showscript
css ".my-class"                      # CSS selector
css "div.container > p:first-child"

text "Click me"                      # Text content (contains)
text "Click me" exact                # Exact match

role button                          # ARIA role
role button "Submit"                 # Role + accessible name
role textbox "Email" exact           # Role + exact name match

label "Email Address"                # Label text
label "Email" exact

placeholder "Enter your email"       # Placeholder attribute

alt "Profile picture"                # Alt text (images)

testid "submit-btn"                  # data-testid attribute
```

### Target Modifiers

```showscript
# Scope: search within a container
css ".item" in css ".container"
role button "Save" in css "form.settings"

# Near: spatial proximity hint (for Teach Mode)
role textbox near text "Username"

# Combined
css "input" in css ".login-form" near text "Password"

# Fallback: try multiple selectors
any(
    css "#main-button",
    role button "Submit",
    text "Submit"
)
```

---

## Step Types

### Navigation

```showscript
# Basic navigation
goto "https://example.com"
goto f"https://example.com/search?q={query | urlencode}"

# With wait condition
goto "https://example.com" wait networkidle
goto "https://example.com" wait domcontentloaded
goto "https://example.com" wait load
goto "https://example.com" wait commit
```

### Waiting

```showscript
# Wait for element
wait css ".loaded"
wait css ".loaded" visible              # visible (default)
wait css ".loaded" exists               # just exists in DOM
wait role button "Continue" visible

# Wait for URL
wait url "/dashboard"                   # URL contains
wait url "/dashboard" exact             # Exact match
wait url r"/users/\d+"                  # Regex

# Wait for load state
wait networkidle
wait domcontentloaded
wait load

# With timeout
wait css ".slow-element" timeout 10s
```

### Clicking

```showscript
# Basic click
click css ".button"
click role button "Submit"
click text "Sign In"

# Options
click css ".button" first               # first match (default)
click css ".item" all                   # click all matches
click css ".button" no-wait             # don't wait for visible
```

### Typing / Filling

```showscript
# Fill input
fill css "input[name='email']" "user@example.com"
fill role textbox "Email" f"{username}@example.com"
fill label "Password" password          # reference to input variable

# Options
fill css "input" "text" no-clear        # don't clear first
fill css "input" "text" append          # append to existing

# Press keys
press "Enter"
press "Tab"
press "Control+a"
press "ArrowDown" times 3
press "ArrowDown" times 3 delay 100ms

# Press on specific element
press "Enter" on css "input.search"
press "Escape" on role dialog
```

### Extraction

```showscript
# Extract to output variable
page_title = title                       # extract page title
heading = text css "h1"                  # extract text content
link = attr css "a.main" "href"          # extract attribute
html_content = html css ".content"       # extract innerHTML

# Multiple elements
all_links = text css "a" all             # array of all matches
all_hrefs = attr css "a" "href" all

# With default value
description = text css ".desc" default "No description"

# Trim whitespace (default: true)
raw_text = text css "p" no-trim
```

### DOM Scraping (Structured Data)

```showscript
# Extract array of objects from repeating elements
products = scrape css ".product-card":
    name = text css ".product-name"
    price = text css ".price"
    url = attr css "a" "href"
    image = attr css "img" "src"
    
# Skip empty rows (default: true)
products = scrape css ".product-card" keep-empty:
    name = text css ".name"
    price = text css ".price"
```

### Variables

```showscript
# Set a variable
set page_num = 1
set is_logged_in = true
set current_url = f"{base_url}/page/{page_num}"

# Reference variables in expressions
fill css "input" f"Page {page_num}"
```

### Assertions

```showscript
# Assert element exists
assert css ".success-message"
assert role alert

# Assert visibility
assert css ".modal" visible
assert css ".loading" not visible

# Assert text content
assert css "h1" contains "Welcome"
assert css ".status" equals "Active"

# Assert URL
assert url contains "/dashboard"
assert url equals "https://example.com/home"

# Custom error message
assert css ".logged-in" message "User should be logged in"
```

### Network Operations

```showscript
# Find a network request
api_request = network find:
    url contains "api.example.com"
    method POST
    status 200
    response contains "success"
    wait 10s                             # wait for request to appear

# Replay with modifications
result = network replay api_request:
    auth browser                         # use browser cookies
    url replace r"/page/\d+" f"/page/{next_page}"
    body replace "limit=10" f"limit={limit}"
    query set page = page_num
    query set limit = 50
    headers set "X-Custom" = "value"
    response json                        # parse as JSON

# Extract from response
items = extract result path "data.items[*].{id, name, status}"
total = extract result path "meta.total"

# Extract as text
raw = extract result as text
```

### Select / Dropdown

```showscript
# Select by value
select css "select.country" value "US"

# Select by visible text
select css "select.country" label "United States"

# Select by index
select css "select.country" index 0

# Multi-select
select css "select.tags" values ["tag1", "tag2", "tag3"]
```

### File Upload

```showscript
upload css "input[type='file']" "./document.pdf"
upload css "input[type='file']" ["./doc1.pdf", "./doc2.pdf"]
```

### Frames / Iframes

```showscript
# Enter iframe
frame enter css "iframe.content"
frame enter name "editor-frame"
frame enter url "editor.example.com"

# ... do stuff inside frame ...

# Exit back to main
frame exit
```

### Tabs

```showscript
# Open new tab
new_tab
new_tab "https://example.com"
tab_index = new_tab "https://example.com"

# Switch tabs
switch_tab 0                             # by index
switch_tab last                          # last opened
switch_tab previous                      # previous tab

# Close current and switch
switch_tab last close-current
```

### Sleep (discouraged)

```showscript
# Prefer wait steps, but available when needed
sleep 2s
sleep 500ms
```

---

## Control Flow

### Conditionals (skip_if)

```showscript
# Skip step if condition met
click css ".cookie-banner button" skip if css ".cookie-banner" not visible

# Multiple conditions
click css ".login" skip if:
    url contains "/dashboard"
    css ".logged-in" visible

# Any condition (OR)
click css ".popup-close" skip if any:
    css ".popup" not visible
    var is_dismissed == true
```

### Step Options

```showscript
# Optional step (won't fail the flow)
click css ".optional-popup" optional

# Custom timeout
wait css ".slow-thing" timeout 30s

# Continue on error (don't stop flow)
click css ".might-not-exist" on-error continue

# Run once per session
click css ".first-time-modal button" once session

# Run once per profile
fill css ".remember-me" "yes" once profile

# Label for logging/debugging
goto "https://example.com":
    label "Navigate to homepage"
```

### Blocks (for grouping)

```showscript
# Named block with shared options
block "Login Flow" timeout 60s:
    goto "https://example.com/login"
    fill label "Email" username
    fill label "Password" password
    click role button "Sign In"
    wait url "/dashboard"
```

---

## Future: Loops (v0.2+)

*Not in initial version, but grammar designed to support:*

```showscript
# For each item
for page in range(1, 10):
    goto f"https://example.com/page/{page}"
    items = scrape css ".item":
        name = text css ".name"
    append items to all_items

# While condition
while css ".next-page" visible:
    page_items = scrape css ".item":
        title = text css ".title"
    append page_items to all_items
    click css ".next-page"

# Loop over extracted data
for company in companies:
    goto f"https://example.com/company/{company.slug}"
    details = scrape css ".details":
        ...
    append details to company_details
```

---

## Formal Grammar (EBNF-ish)

```ebnf
(* Top level *)
program         = { block_section } ;
block_section   = meta_block | inputs_block | outputs_block | flow_block ;

(* Metadata *)
meta_block      = "meta" ":" NEWLINE INDENT { meta_field } DEDENT ;
meta_field      = IDENT ":" string_literal NEWLINE ;

(* Inputs/Outputs *)
inputs_block    = "inputs" ":" NEWLINE INDENT { input_decl } DEDENT ;
input_decl      = IDENT ":" type_spec [ "=" literal ] [ comment ] NEWLINE ;
type_spec       = "string" | "number" | "bool" | "secret" | "array" | "object" ;

outputs_block   = "outputs" ":" NEWLINE INDENT { output_decl } DEDENT ;
output_decl     = IDENT ":" type_spec [ comment ] NEWLINE ;

(* Flow *)
flow_block      = "flow" ":" NEWLINE INDENT { statement } DEDENT ;
statement       = step_stmt | assign_stmt | block_stmt ;

(* Assignment *)
assign_stmt     = IDENT "=" expression NEWLINE ;

(* Steps *)
step_stmt       = step_expr { step_modifier } [ ":" NEWLINE INDENT { step_option } DEDENT ] NEWLINE ;
step_expr       = navigation_step | wait_step | click_step | fill_step | press_step
                | extract_step | scrape_step | assert_step | network_step
                | select_step | upload_step | frame_step | tab_step | sleep_step
                | set_step ;

(* Step modifiers *)
step_modifier   = "optional" | "timeout" duration | "on-error" error_action
                | "skip" "if" skip_condition | "once" once_scope ;
error_action    = "continue" | "stop" ;
once_scope      = "session" | "profile" ;

(* Skip conditions *)
skip_condition  = single_condition | compound_condition ;
single_condition = target_expr [ "not" ] "visible"
                 | target_expr [ "not" ] "exists"  
                 | "url" "contains" string_literal
                 | "url" "equals" string_literal
                 | "var" IDENT compare_op literal ;
compound_condition = ":" NEWLINE INDENT { single_condition NEWLINE } DEDENT
                   | "any" ":" NEWLINE INDENT { single_condition NEWLINE } DEDENT ;
compare_op      = "==" | "!=" | ">" | "<" | ">=" | "<=" ;

(* Target expressions *)
target_expr     = target_primary { target_modifier } ;
target_primary  = "css" string_literal
                | "text" string_literal [ "exact" ]
                | "role" role_name [ string_literal ] [ "exact" ]
                | "label" string_literal [ "exact" ]
                | "placeholder" string_literal [ "exact" ]
                | "alt" string_literal [ "exact" ]
                | "testid" string_literal
                | "any" "(" target_expr { "," target_expr } ")" ;
target_modifier = "in" target_primary | "near" target_primary ;
role_name       = "button" | "textbox" | "link" | "checkbox" | "radio"
                | "combobox" | "listbox" | "menuitem" | "tab" | "dialog"
                | "alert" | "switch" | "slider" | "searchbox" | "option"
                | (* ... other ARIA roles *) ;

(* Navigation *)
navigation_step = "goto" string_expr [ "wait" wait_until ] ;
wait_until      = "networkidle" | "domcontentloaded" | "load" | "commit" ;

(* Wait *)
wait_step       = "wait" ( target_expr wait_state | "url" url_match | load_state ) ;
wait_state      = [ "visible" | "exists" ] ;
url_match       = string_literal [ "exact" ] | "r" string_literal ;
load_state      = "networkidle" | "domcontentloaded" | "load" ;

(* Click *)
click_step      = "click" target_expr [ "first" | "all" ] [ "no-wait" ] ;

(* Fill *)
fill_step       = "fill" target_expr string_expr [ "no-clear" | "append" ] ;

(* Press *)
press_step      = "press" string_literal [ "on" target_expr ] 
                  [ "times" NUMBER ] [ "delay" duration ] ;

(* Extract *)
extract_step    = "title"
                | "text" target_expr [ "all" ] [ "no-trim" ] [ "default" literal ]
                | "attr" target_expr string_literal [ "all" ] [ "default" literal ]
                | "html" target_expr [ "all" ] ;

(* Scrape *)
scrape_step     = "scrape" target_expr [ "keep-empty" ] ":" NEWLINE 
                  INDENT { scrape_field } DEDENT ;
scrape_field    = IDENT "=" ( "text" target_expr | "attr" target_expr string_literal | "html" target_expr ) NEWLINE ;

(* Assert *)
assert_step     = "assert" ( target_expr assert_check | "url" url_check ) 
                  [ "message" string_literal ] ;
assert_check    = [ "visible" | "not" "visible" | "exists" ]
                | "contains" string_literal
                | "equals" string_literal ;
url_check       = "contains" string_literal | "equals" string_literal ;

(* Network *)
network_step    = network_find | network_replay | network_extract ;
network_find    = "network" "find" ":" NEWLINE INDENT { network_where } DEDENT ;
network_where   = "url" "contains" string_literal NEWLINE
                | "method" http_method NEWLINE
                | "status" NUMBER NEWLINE
                | "response" "contains" string_literal NEWLINE
                | "wait" duration NEWLINE ;
http_method     = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" ;

network_replay  = "network" "replay" IDENT ":" NEWLINE INDENT { replay_option } DEDENT ;
replay_option   = "auth" "browser" NEWLINE
                | "url" "replace" string_literal string_expr NEWLINE
                | "body" "replace" string_literal string_expr NEWLINE
                | "query" "set" IDENT "=" expression NEWLINE
                | "headers" "set" string_literal "=" string_expr NEWLINE
                | "response" ( "json" | "text" ) NEWLINE ;

network_extract = "extract" IDENT [ "path" string_literal ] [ "as" ( "json" | "text" ) ] ;

(* Select *)
select_step     = "select" target_expr select_option ;
select_option   = "value" string_expr
                | "label" string_expr  
                | "index" NUMBER
                | "values" array_literal ;

(* Upload *)
upload_step     = "upload" target_expr ( string_literal | array_literal ) ;

(* Frame *)
frame_step      = "frame" ( "enter" frame_target | "exit" ) ;
frame_target    = "css" string_literal | "name" string_literal | "url" string_literal ;

(* Tab *)
tab_step        = "new_tab" [ string_expr ]
                | "switch_tab" ( NUMBER | "last" | "previous" ) [ "close-current" ] ;

(* Sleep *)
sleep_step      = "sleep" duration ;

(* Set variable *)
set_step        = "set" IDENT "=" expression ;

(* Block *)
block_stmt      = "block" string_literal { step_modifier } ":" NEWLINE 
                  INDENT { statement } DEDENT ;

(* Expressions *)
expression      = literal | IDENT | string_expr | target_expr | step_expr ;
string_expr     = string_literal | f_string ;
string_literal  = '"' { CHAR } '"' | "'" { CHAR } "'" ;
f_string        = 'f"' { CHAR | interpolation } '"' ;
interpolation   = "{" IDENT { "|" filter } "}" ;
filter          = IDENT [ ":" literal ] ;

(* Literals *)
literal         = string_literal | NUMBER | BOOL | "none" | array_literal | duration ;
array_literal   = "[" [ expression { "," expression } ] "]" ;
duration        = NUMBER ( "s" | "ms" | "m" ) ;

(* Tokens *)
IDENT           = /[a-zA-Z_][a-zA-Z0-9_]*/ ;
NUMBER          = /\d+(\.\d+)?/ ;
BOOL            = "true" | "false" ;
NEWLINE         = /\n/ ;
INDENT          = (* increase in indentation *) ;
DEDENT          = (* decrease in indentation *) ;
comment         = "#" { CHAR } NEWLINE ;
```

---

## Compilation Examples

### Example 1: Simple Page Scrape

**ShowScript:**
```showscript
inputs:
    url: string

outputs:
    page_title: string
    h1_text: string

flow:
    goto url wait networkidle
    wait css "h1" visible timeout 5s
    page_title = title
    h1_text = text css "h1"
```

**Compiles to JSON-DSL:**
```json
{
  "inputs": {
    "url": { "type": "string", "required": true }
  },
  "collectibles": [
    { "name": "page_title", "type": "string" },
    { "name": "h1_text", "type": "string" }
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
      "params": { "target": { "kind": "css", "selector": "h1" }, "visible": true, "timeoutMs": 5000 }
    },
    {
      "id": "step_3",
      "type": "extract_title",
      "params": { "out": "page_title" }
    },
    {
      "id": "step_4",
      "type": "extract_text",
      "params": { "target": { "kind": "css", "selector": "h1" }, "out": "h1_text" }
    }
  ]
}
```

### Example 2: YC Companies Collector

**ShowScript:**
```showscript
meta:
    id: "yc-batch-companies"
    name: "YC Batch Company Collector"
    version: "1.0.0"

inputs:
    batch: string = "Winter 2024"

outputs:
    companies: array

flow:
    goto f"https://www.ycombinator.com/companies?batch={batch | urlencode}"
    
    algolia_req = network find:
        url contains "algolia.net"
        method POST
        response contains "one_liner"
        wait 10s
    
    companies = network replay algolia_req:
        auth browser
        body replace "batch%3AWinter%202024" f"batch%3A{batch | urlencode}"
        response json
        path "results[0].hits[*].{name, slug, website, one_liner, batch, industry, team_size, status, isHiring, all_locations}"
```

### Example 3: Login with Conditionals

**ShowScript:**
```showscript
inputs:
    username: string
    password: secret

outputs:
    logged_in: bool

flow:
    goto "https://example.com/login"
    
    # Accept cookies if banner present
    click css ".cookie-accept" optional skip if css ".cookie-banner" not visible
    
    fill label "Email" username
    fill label "Password" password
    click role button "Sign In"
    
    wait url "/dashboard" timeout 10s
    
    set logged_in = true
    assert css ".user-menu" visible message "Login failed"
```

---

## File Extension

`.showscript` or `.ss`

---

## Implementation Notes

### Parser Strategy

1. **Lexer** — Tokenize with indentation tracking (like Python)
2. **Parser** — Recursive descent or PEG parser
3. **AST** — Build abstract syntax tree
4. **Compiler** — Walk AST, emit JSON-DSL

### Recommended Tools

- **TypeScript:** Use a PEG parser like `peggy` (successor to PEG.js)
- **Indentation:** Track indent/dedent as tokens (Python-style)
- **Error messages:** Source maps for good error locations

### Integration

```bash
# Compile .showscript to flow.json
showrun compile ./my-flow.showscript -o ./taskpack/flow.json

# Or auto-detect in taskpack
showrun run ./taskpack  # auto-compiles if flow.showscript exists
```

---

## Open Questions

1. **Loops** — Should we include them in v1, or defer to v0.2?
2. **Functions/Macros** — Reusable step groups?
3. **Imports** — Import common patterns from other files?
4. **Comments in JSON output** — Preserve as `label` fields?
5. **Debugging** — Source maps for step-to-line mapping?

---

## Changelog

- **0.1.0-draft** — Initial grammar design
