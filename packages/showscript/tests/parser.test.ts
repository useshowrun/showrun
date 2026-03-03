import { describe, it, expect } from "vitest";
import { parse, ShowScriptSyntaxError } from "../src/index.js";
import type {
  Program,
  FlowBlock,
  StepStatement,
  AssignStatement,
  IfStatement,
  WhileStatement,
  ForStatement,
  YieldStatement,
  StepCall,
  Expression,
  NumberLiteral,
  StringLiteral,
  BooleanLiteral,
  DurationLiteral,
  FString,
  RawString,
  ArrayLiteral,
  ObjectLiteral,
  Identifier,
  PropertyAccess,
  TargetExpression,
  BinaryExpression,
  UnaryExpression,
  ExtractionExpression,
  MetaBlock,
  InputsBlock,
  OutputsBlock,
} from "../src/ast.js";

// Helpers
function parseFlow(src: string): FlowBlock {
  const ast = parse(`flow:\n${src}`);
  return ast.blocks[0] as FlowBlock;
}

function parseExpr(src: string): Expression {
  const flow = parseFlow(`    x = ${src}`);
  return (flow.statements[0] as AssignStatement).value;
}

function parseStmt(src: string) {
  const flow = parseFlow(`    ${src}`);
  return flow.statements[0];
}

// ─── Literals ────────────────────────────────────────────────

describe("Literals", () => {
  describe("Numbers", () => {
    it("parses integers", () => {
      const expr = parseExpr("42") as NumberLiteral;
      expect(expr.type).toBe("NumberLiteral");
      expect(expr.value).toBe(42);
    });

    it("parses floats", () => {
      const expr = parseExpr("3.14") as NumberLiteral;
      expect(expr.type).toBe("NumberLiteral");
      expect(expr.value).toBe(3.14);
    });

    it("parses negative numbers via unary operator", () => {
      const expr = parseExpr("-10") as UnaryExpression;
      expect(expr.type).toBe("UnaryExpression");
      expect(expr.operator).toBe("-");
      expect((expr.operand as NumberLiteral).value).toBe(10);
    });
  });

  describe("Strings", () => {
    it("parses double-quoted strings", () => {
      const expr = parseExpr('"hello world"') as StringLiteral;
      expect(expr.type).toBe("StringLiteral");
      expect(expr.value).toBe("hello world");
      expect(expr.quote).toBe('"');
    });

    it("parses single-quoted strings", () => {
      const expr = parseExpr("'hello'") as StringLiteral;
      expect(expr.type).toBe("StringLiteral");
      expect(expr.value).toBe("hello");
      expect(expr.quote).toBe("'");
    });

    it("handles escape sequences", () => {
      const expr = parseExpr('"line1\\nline2"') as StringLiteral;
      expect(expr.value).toBe("line1\nline2");
    });

    it("handles tab escape", () => {
      const expr = parseExpr('"col1\\tcol2"') as StringLiteral;
      expect(expr.value).toBe("col1\tcol2");
    });

    it("handles escaped backslash", () => {
      const expr = parseExpr('"path\\\\to\\\\file"') as StringLiteral;
      expect(expr.value).toBe("path\\to\\file");
    });

    it("handles escaped quotes", () => {
      const expr = parseExpr('"say \\"hello\\""') as StringLiteral;
      expect(expr.value).toBe('say "hello"');
    });
  });

  describe("F-strings", () => {
    it("parses simple f-string", () => {
      const expr = parseExpr('f"Hello {name}"') as FString;
      expect(expr.type).toBe("FString");
      expect(expr.parts).toHaveLength(2);
      expect(expr.parts[0].type).toBe("FStringText");
      expect(expr.parts[1].type).toBe("FStringInterpolation");
      if (expr.parts[1].type === "FStringInterpolation") {
        expect(expr.parts[1].identifier).toBe("name");
      }
    });

    it("parses single-quoted f-string", () => {
      const expr = parseExpr("f'Hello {name}'") as FString;
      expect(expr.type).toBe("FString");
      expect(expr.quote).toBe("'");
    });

    it("parses f-string with filter", () => {
      const expr = parseExpr('f"URL: {url | urlencode}"') as FString;
      const interp = expr.parts[1];
      expect(interp.type).toBe("FStringInterpolation");
      if (interp.type === "FStringInterpolation") {
        expect(interp.filters).toHaveLength(1);
        expect(interp.filters[0].name).toBe("urlencode");
      }
    });

    it("parses f-string with filter argument", () => {
      const expr = parseExpr('f"Page {page | default: 1}"') as FString;
      const interp = expr.parts[1];
      if (interp.type === "FStringInterpolation") {
        expect(interp.filters[0].name).toBe("default");
        expect(interp.filters[0].argument).toBeDefined();
        expect((interp.filters[0].argument as NumberLiteral).value).toBe(1);
      }
    });

    it("parses f-string with string filter argument", () => {
      const expr = parseExpr("f\"Items: {items | join: ', '}\"") as FString;
      const interp = expr.parts[1];
      if (interp.type === "FStringInterpolation") {
        expect(interp.filters[0].name).toBe("join");
        expect((interp.filters[0].argument as StringLiteral).value).toBe(", ");
      }
    });
  });

  describe("Raw strings", () => {
    it("parses raw double-quoted string", () => {
      const expr = parseExpr('r"regex \\d+"') as RawString;
      expect(expr.type).toBe("RawString");
      expect(expr.value).toBe("regex \\d+");
      expect(expr.quote).toBe('"');
    });

    it("parses raw single-quoted string", () => {
      const expr = parseExpr("r'C:\\Users\\name'") as RawString;
      expect(expr.type).toBe("RawString");
      expect(expr.value).toBe("C:\\Users\\name");
    });
  });

  describe("Booleans", () => {
    it("parses true", () => {
      const expr = parseExpr("true") as BooleanLiteral;
      expect(expr.type).toBe("BooleanLiteral");
      expect(expr.value).toBe(true);
    });

    it("parses false", () => {
      const expr = parseExpr("false") as BooleanLiteral;
      expect(expr.type).toBe("BooleanLiteral");
      expect(expr.value).toBe(false);
    });
  });

  describe("Durations", () => {
    it("parses seconds", () => {
      const expr = parseExpr("5s") as DurationLiteral;
      expect(expr.type).toBe("DurationLiteral");
      expect(expr.value).toBe(5);
      expect(expr.unit).toBe("s");
    });

    it("parses milliseconds", () => {
      const expr = parseExpr("100ms") as DurationLiteral;
      expect(expr.type).toBe("DurationLiteral");
      expect(expr.value).toBe(100);
      expect(expr.unit).toBe("ms");
    });

    it("parses minutes", () => {
      const expr = parseExpr("1m") as DurationLiteral;
      expect(expr.type).toBe("DurationLiteral");
      expect(expr.value).toBe(1);
      expect(expr.unit).toBe("m");
    });

    it("parses fractional durations", () => {
      const expr = parseExpr("1.5s") as DurationLiteral;
      expect(expr.type).toBe("DurationLiteral");
      expect(expr.value).toBe(1.5);
      expect(expr.unit).toBe("s");
    });
  });

  describe("Null", () => {
    it("parses null", () => {
      const expr = parseExpr("null");
      expect(expr.type).toBe("NullLiteral");
    });
  });

  describe("Arrays", () => {
    it("parses empty array", () => {
      const expr = parseExpr("[]") as ArrayLiteral;
      expect(expr.type).toBe("ArrayLiteral");
      expect(expr.elements).toHaveLength(0);
    });

    it("parses array with elements", () => {
      const expr = parseExpr('[1, "two", true]') as ArrayLiteral;
      expect(expr.elements).toHaveLength(3);
      expect(expr.elements[0].type).toBe("NumberLiteral");
      expect(expr.elements[1].type).toBe("StringLiteral");
      expect(expr.elements[2].type).toBe("BooleanLiteral");
    });

    it("parses array with trailing comma", () => {
      const expr = parseExpr("[1, 2, 3,]") as ArrayLiteral;
      expect(expr.elements).toHaveLength(3);
    });

    it("parses array with variables", () => {
      const expr = parseExpr("[price1, price2]") as ArrayLiteral;
      expect(expr.elements).toHaveLength(2);
      expect(expr.elements[0].type).toBe("Identifier");
    });
  });

  describe("Objects", () => {
    it("parses empty object", () => {
      const expr = parseExpr("{}") as ObjectLiteral;
      expect(expr.type).toBe("ObjectLiteral");
      expect(expr.fields).toHaveLength(0);
    });

    it("parses object with fields", () => {
      const expr = parseExpr('{ name: "test", count: 42 }') as ObjectLiteral;
      expect(expr.fields).toHaveLength(2);
      expect(expr.fields[0].key).toBe("name");
      expect(expr.fields[1].key).toBe("count");
    });

    it("parses object with trailing comma", () => {
      const expr = parseExpr('{ x: 1, y: 2, }') as ObjectLiteral;
      expect(expr.fields).toHaveLength(2);
    });
  });
});

// ─── Target Selectors ────────────────────────────────────────

describe("Target Selectors", () => {
  it("parses @css target", () => {
    const expr = parseExpr('@css(".my-class")') as TargetExpression;
    expect(expr.type).toBe("TargetExpression");
    expect(expr.target.type).toBe("TargetPrimary");
    if (expr.target.type === "TargetPrimary") {
      expect(expr.target.targetType).toBe("css");
      expect(expr.target.args).toHaveLength(1);
    }
  });

  it("parses @text target", () => {
    const expr = parseExpr('@text("Click me")') as TargetExpression;
    if (expr.target.type === "TargetPrimary") {
      expect(expr.target.targetType).toBe("text");
    }
  });

  it("parses @text with exact option", () => {
    const expr = parseExpr('@text("Click me", exact: true)') as TargetExpression;
    if (expr.target.type === "TargetPrimary") {
      expect(expr.target.args).toHaveLength(2);
      expect(expr.target.args[1].type).toBe("NamedArgument");
    }
  });

  it("parses @role target", () => {
    const expr = parseExpr('@role("button")') as TargetExpression;
    if (expr.target.type === "TargetPrimary") {
      expect(expr.target.targetType).toBe("role");
    }
  });

  it("parses @role with name", () => {
    const expr = parseExpr('@role("button", "Submit")') as TargetExpression;
    if (expr.target.type === "TargetPrimary") {
      expect(expr.target.args).toHaveLength(2);
    }
  });

  it("parses @label target", () => {
    const expr = parseExpr('@label("Email Address")') as TargetExpression;
    if (expr.target.type === "TargetPrimary") {
      expect(expr.target.targetType).toBe("label");
    }
  });

  it("parses @attr with one arg (existence check)", () => {
    const expr = parseExpr('@attr("disabled")') as TargetExpression;
    if (expr.target.type === "TargetPrimary") {
      expect(expr.target.targetType).toBe("attr");
      expect(expr.target.args).toHaveLength(1);
    }
  });

  it("parses @attr with two args (value equality)", () => {
    const expr = parseExpr('@attr("data-testid", "submit-btn")') as TargetExpression;
    if (expr.target.type === "TargetPrimary") {
      expect(expr.target.args).toHaveLength(2);
    }
  });

  it("parses .in() modifier", () => {
    const expr = parseExpr('@css(".item").in(@css(".container"))') as TargetExpression;
    expect(expr.modifiers).toHaveLength(1);
    expect(expr.modifiers[0].kind).toBe("in");
  });

  it("parses .near() modifier", () => {
    const expr = parseExpr('@role("textbox").near(@text("Username"))') as TargetExpression;
    expect(expr.modifiers).toHaveLength(1);
    expect(expr.modifiers[0].kind).toBe("near");
  });

  it("parses combined modifiers", () => {
    const expr = parseExpr(
      '@css("input").in(@css(".login-form")).near(@text("Password"))'
    ) as TargetExpression;
    expect(expr.modifiers).toHaveLength(2);
    expect(expr.modifiers[0].kind).toBe("in");
    expect(expr.modifiers[1].kind).toBe("near");
  });

  it("parses @any fallback", () => {
    const expr = parseExpr(
      '@any(\n        @css("#main-button"),\n        @role("button", "Submit"),\n        @text("Submit")\n    )'
    ) as TargetExpression;
    expect(expr.target.type).toBe("AnyTarget");
    if (expr.target.type === "AnyTarget") {
      expect(expr.target.targets).toHaveLength(3);
    }
  });

  it("parses .visible property", () => {
    const expr = parseExpr('@css(".element").visible') as TargetExpression;
    expect(expr.property).toBe("visible");
  });

  it("parses .exists property", () => {
    const expr = parseExpr('@css(".element").exists') as TargetExpression;
    expect(expr.property).toBe("exists");
  });

  it("parses .empty on target", () => {
    const expr = parseExpr('@css(".items").empty') as TargetExpression;
    expect(expr.property).toBe("empty");
  });

  it("parses target with modifier and property", () => {
    const expr = parseExpr(
      '@css(".modal").in(@css(".page")).visible'
    ) as TargetExpression;
    expect(expr.modifiers).toHaveLength(1);
    expect(expr.property).toBe("visible");
  });
});

// ─── Step Types ──────────────────────────────────────────────

describe("Step Types", () => {
  it("parses goto", () => {
    const stmt = parseStmt('goto("https://example.com")') as StepStatement;
    expect(stmt.type).toBe("StepStatement");
    expect(stmt.call.name).toBe("goto");
    expect(stmt.call.args).toHaveLength(1);
  });

  it("parses goto with named arg", () => {
    const stmt = parseStmt(
      'goto("https://example.com", wait: "networkidle")'
    ) as StepStatement;
    expect(stmt.call.args).toHaveLength(2);
    expect(stmt.call.args[1].type).toBe("NamedArgument");
  });

  it("parses click", () => {
    const stmt = parseStmt('click(@css(".button"))') as StepStatement;
    expect(stmt.call.name).toBe("click");
  });

  it("parses click with options", () => {
    const stmt = parseStmt(
      'click(@css(".item"), all: true)'
    ) as StepStatement;
    expect(stmt.call.args).toHaveLength(2);
  });

  it("parses fill", () => {
    const stmt = parseStmt(
      'fill(@css("input[name=\'email\']"), "user@example.com")'
    ) as StepStatement;
    expect(stmt.call.name).toBe("fill");
    expect(stmt.call.args).toHaveLength(2);
  });

  it("parses press", () => {
    const stmt = parseStmt('press("Enter")') as StepStatement;
    expect(stmt.call.name).toBe("press");
  });

  it("parses press with options", () => {
    const stmt = parseStmt(
      'press("ArrowDown", times: 3, delay: 100ms)'
    ) as StepStatement;
    expect(stmt.call.args).toHaveLength(3);
  });

  it("parses wait with target", () => {
    const stmt = parseStmt('wait(@css(".loaded"))') as StepStatement;
    expect(stmt.call.name).toBe("wait");
  });

  it("parses wait with condition", () => {
    const stmt = parseStmt(
      'wait(contains(url, "/dashboard"), timeout: 10s)'
    ) as StepStatement;
    expect(stmt.call.args).toHaveLength(2);
  });

  it("parses wait with load state identifier", () => {
    const stmt = parseStmt("wait(networkidle)") as StepStatement;
    expect(stmt.call.name).toBe("wait");
    const arg = stmt.call.args[0];
    expect(arg.type).toBe("PositionalArgument");
  });

  it("parses scrape", () => {
    const stmt = parseStmt(
      `products = scrape(@css(".product-card"), {
        name: text(@css(".product-name")),
        price: text(@css(".price")),
        url: attr(@css("a"), "href"),
    })`
    ) as AssignStatement;
    expect(stmt.type).toBe("AssignStatement");
    expect(stmt.name).toBe("products");
    const call = stmt.value as StepCall;
    expect(call.name).toBe("scrape");
  });

  it("parses scrape with first option", () => {
    const stmt = parseStmt(
      `product = scrape(@css(".card"), {
        name: text(@css(".name")),
    }, first: true)`
    ) as AssignStatement;
    const call = stmt.value as StepCall;
    expect(call.args).toHaveLength(3);
  });

  it("parses assert with target", () => {
    const stmt = parseStmt('assert(@css(".success-message"))') as StepStatement;
    expect(stmt.call.name).toBe("assert");
  });

  it("parses assert with options", () => {
    const stmt = parseStmt(
      'assert(@css(".user-menu"), visible: true, message: "Login failed")'
    ) as StepStatement;
    expect(stmt.call.args).toHaveLength(3);
  });

  it("parses assert with comparison function", () => {
    const stmt = parseStmt(
      'assert(contains(url, "/dashboard"))'
    ) as StepStatement;
    expect(stmt.call.name).toBe("assert");
  });

  it("parses dotted step call: network.find", () => {
    const stmt = parseStmt(
      `api_req = network.find(
        conditions: [contains(url, "api")],
        wait: 10s
    )`
    ) as AssignStatement;
    const call = stmt.value as StepCall;
    expect(call.name).toBe("network.find");
  });

  it("parses dotted step call: network.replay", () => {
    const stmt = parseStmt(
      `result = network.replay(api_req, {
        auth: "browser",
        response: "json",
    })`
    ) as AssignStatement;
    const call = stmt.value as StepCall;
    expect(call.name).toBe("network.replay");
  });

  it("parses extract step call", () => {
    const stmt = parseStmt(
      'items = extract(result, path: "data.items[*]")'
    ) as AssignStatement;
    const call = stmt.value as StepCall;
    expect(call.name).toBe("extract");
  });

  it("parses select with named arg", () => {
    const stmt = parseStmt(
      'select(@css("select.country"), value: "US")'
    ) as StepStatement;
    expect(stmt.call.name).toBe("select");
  });

  it("parses frame.enter and frame.exit", () => {
    const flow = parseFlow(`    frame.enter(@css("iframe.content"))
    frame.exit()`);
    expect(flow.statements).toHaveLength(2);
    expect((flow.statements[0] as StepStatement).call.name).toBe("frame.enter");
    expect((flow.statements[1] as StepStatement).call.name).toBe("frame.exit");
  });

  it("parses new_tab and switch_tab", () => {
    const flow = parseFlow(`    new_tab("https://example.com")
    switch_tab(0)`);
    expect((flow.statements[0] as StepStatement).call.name).toBe("new_tab");
    expect((flow.statements[1] as StepStatement).call.name).toBe("switch_tab");
  });

  it("parses sleep with duration", () => {
    const stmt = parseStmt("sleep(2s)") as StepStatement;
    expect(stmt.call.name).toBe("sleep");
    const arg = stmt.call.args[0];
    if (arg.type === "PositionalArgument") {
      expect(arg.value.type).toBe("DurationLiteral");
    }
  });

  it("parses upload step", () => {
    const stmt = parseStmt(
      'upload(@css("input[type=\'file\']"), "./document.pdf")'
    ) as StepStatement;
    expect(stmt.call.name).toBe("upload");
  });

  it("parses title() function", () => {
    const stmt = parseStmt("page_title = title()") as AssignStatement;
    const call = stmt.value as StepCall;
    expect(call.name).toBe("title");
    expect(call.args).toHaveLength(0);
  });

  it("parses step with label option", () => {
    const stmt = parseStmt(
      'goto("https://example.com", label: "Navigate to homepage")'
    ) as StepStatement;
    const args = stmt.call.args;
    expect(args).toHaveLength(2);
    expect(args[1].type).toBe("NamedArgument");
  });

  it("parses step with optional: true", () => {
    const stmt = parseStmt(
      'click(@css(".optional-popup"), optional: true)'
    ) as StepStatement;
    expect(stmt.call.args).toHaveLength(2);
  });
});

// ─── Control Flow ────────────────────────────────────────────

describe("Control Flow", () => {
  describe("If/Elif/Else", () => {
    it("parses basic if", () => {
      const stmt = parseStmt(
        'if (@css(".cookie-banner").visible) {\n        click(@css(".cookie-accept"))\n    }'
      ) as IfStatement;
      expect(stmt.type).toBe("IfStatement");
      expect(stmt.body).toHaveLength(1);
      expect(stmt.elifs).toHaveLength(0);
      expect(stmt.elseBody).toBeUndefined();
    });

    it("parses if-else", () => {
      const stmt = parseStmt(
        `if (@css(".logged-in").visible) {
            goto("https://example.com/dashboard")
        } else {
            goto("https://example.com/login")
        }`
      ) as IfStatement;
      expect(stmt.body).toHaveLength(1);
      expect(stmt.elseBody).toHaveLength(1);
    });

    it("parses if-elif-else", () => {
      const stmt = parseStmt(
        `if (@css(".cookie-modal").visible) {
            click(@role("button", "Accept All"))
        } elif (@css(".gdpr-banner").visible) {
            click(@css(".gdpr-accept"))
        } else {
            goto("https://example.com")
        }`
      ) as IfStatement;
      expect(stmt.elifs).toHaveLength(1);
      expect(stmt.elseBody).toHaveLength(1);
    });

    it("parses negation condition", () => {
      const stmt = parseStmt(
        `if (!@css(".element").visible) {
            click(@css(".show"))
        }`
      ) as IfStatement;
      expect(stmt.condition.type).toBe("UnaryExpression");
    });

    it("parses empty blocks", () => {
      const stmt = parseStmt(
        `if (@css(".optional").visible) {
        }`
      ) as IfStatement;
      expect(stmt.body).toHaveLength(0);
    });
  });

  describe("While loops", () => {
    it("parses basic while", () => {
      const stmt = parseStmt(
        `while (page < max_pages) {
            click(@css(".next"))
            wait(networkidle)
        }`
      ) as WhileStatement;
      expect(stmt.type).toBe("WhileStatement");
      expect(stmt.body).toHaveLength(2);
      expect(stmt.assignTo).toBeUndefined();
    });

    it("parses while as expression with assignment", () => {
      const stmt = parseStmt(
        `results = while (page <= max_pages) {
            yield items
        }`
      ) as WhileStatement;
      expect(stmt.type).toBe("WhileStatement");
      expect(stmt.assignTo).toBe("results");
      expect(stmt.body).toHaveLength(1);
      expect(stmt.body[0].type).toBe("YieldStatement");
    });
  });

  describe("For loops", () => {
    it("parses basic for with range", () => {
      const stmt = parseStmt(
        `for (i in range(1, 5)) {
            click(@css(".next"))
            wait(networkidle)
        }`
      ) as ForStatement;
      expect(stmt.type).toBe("ForStatement");
      expect(stmt.variable).toBe("i");
      expect(stmt.iterable.type).toBe("RangeExpression");
      expect(stmt.body).toHaveLength(2);
    });

    it("parses for with identifier iterable", () => {
      const stmt = parseStmt(
        `for (company in companies) {
            goto(f"https://example.com/company/{company}")
        }`
      ) as ForStatement;
      expect(stmt.variable).toBe("company");
      expect(stmt.iterable.type).toBe("Identifier");
    });

    it("parses for as expression with assignment", () => {
      const stmt = parseStmt(
        `all_items = for (page in range(1, 10)) {
            yield items
        }`
      ) as ForStatement;
      expect(stmt.type).toBe("ForStatement");
      expect(stmt.assignTo).toBe("all_items");
      expect(stmt.variable).toBe("page");
      expect(stmt.iterable.type).toBe("RangeExpression");
    });
  });

  describe("Yield", () => {
    it("parses yield with expression", () => {
      const flow = parseFlow(
        `    while (true) {
        yield items
    }`
      );
      const whileStmt = flow.statements[0] as WhileStatement;
      expect(whileStmt.body[0].type).toBe("YieldStatement");
      expect((whileStmt.body[0] as YieldStatement).value.type).toBe("Identifier");
    });

    it("parses yield with object literal", () => {
      const flow = parseFlow(
        `    for (x in items) {
        yield { name: x, source: "test" }
    }`
      );
      const forStmt = flow.statements[0] as ForStatement;
      const yieldStmt = forStmt.body[0] as YieldStatement;
      expect(yieldStmt.value.type).toBe("ObjectLiteral");
    });
  });
});

// ─── Expressions ─────────────────────────────────────────────

describe("Expressions", () => {
  describe("Arithmetic", () => {
    it("parses addition", () => {
      const expr = parseExpr("a + b") as BinaryExpression;
      expect(expr.type).toBe("BinaryExpression");
      expect(expr.operator).toBe("+");
    });

    it("parses subtraction", () => {
      const expr = parseExpr("a - b") as BinaryExpression;
      expect(expr.operator).toBe("-");
    });

    it("parses multiplication", () => {
      const expr = parseExpr("a * b") as BinaryExpression;
      expect(expr.operator).toBe("*");
    });

    it("parses division", () => {
      const expr = parseExpr("a / b") as BinaryExpression;
      expect(expr.operator).toBe("/");
    });

    it("parses modulo", () => {
      const expr = parseExpr("a % b") as BinaryExpression;
      expect(expr.operator).toBe("%");
    });
  });

  describe("Comparison", () => {
    it("parses ==", () => {
      const expr = parseExpr("a == b") as BinaryExpression;
      expect(expr.operator).toBe("==");
    });

    it("parses !=", () => {
      const expr = parseExpr("a != b") as BinaryExpression;
      expect(expr.operator).toBe("!=");
    });

    it("parses >", () => {
      const expr = parseExpr("a > b") as BinaryExpression;
      expect(expr.operator).toBe(">");
    });

    it("parses <", () => {
      const expr = parseExpr("a < b") as BinaryExpression;
      expect(expr.operator).toBe("<");
    });

    it("parses >=", () => {
      const expr = parseExpr("a >= b") as BinaryExpression;
      expect(expr.operator).toBe(">=");
    });

    it("parses <=", () => {
      const expr = parseExpr("a <= b") as BinaryExpression;
      expect(expr.operator).toBe("<=");
    });
  });

  describe("Logical", () => {
    it("parses &&", () => {
      const expr = parseExpr("a && b") as BinaryExpression;
      expect(expr.operator).toBe("&&");
    });

    it("parses ||", () => {
      const expr = parseExpr("a || b") as BinaryExpression;
      expect(expr.operator).toBe("||");
    });

    it("parses !", () => {
      const expr = parseExpr("!a") as UnaryExpression;
      expect(expr.type).toBe("UnaryExpression");
      expect(expr.operator).toBe("!");
    });
  });

  describe("Precedence", () => {
    it("multiplication before addition", () => {
      const expr = parseExpr("a + b * c") as BinaryExpression;
      expect(expr.operator).toBe("+");
      expect((expr.right as BinaryExpression).operator).toBe("*");
    });

    it("comparison before logical", () => {
      const expr = parseExpr("a > 0 && b < 10") as BinaryExpression;
      expect(expr.operator).toBe("&&");
      expect((expr.left as BinaryExpression).operator).toBe(">");
      expect((expr.right as BinaryExpression).operator).toBe("<");
    });

    it("&& before ||", () => {
      const expr = parseExpr("a || b && c") as BinaryExpression;
      expect(expr.operator).toBe("||");
      expect((expr.right as BinaryExpression).operator).toBe("&&");
    });

    it("parentheses override precedence", () => {
      const expr = parseExpr("(a + b) * c") as BinaryExpression;
      expect(expr.operator).toBe("*");
      expect(expr.left.type).toBe("GroupExpression");
    });

    it("complex precedence", () => {
      const expr = parseExpr("!success && (attempts < max_retries)") as BinaryExpression;
      expect(expr.operator).toBe("&&");
      expect(expr.left.type).toBe("UnaryExpression");
      expect(expr.right.type).toBe("GroupExpression");
    });
  });

  describe("Property access", () => {
    it("parses simple property", () => {
      const expr = parseExpr("company.name") as PropertyAccess;
      expect(expr.type).toBe("PropertyAccess");
      expect(expr.property).toBe("name");
      expect((expr.object as Identifier).name).toBe("company");
    });

    it("parses chained property", () => {
      const expr = parseExpr("a.b.c") as PropertyAccess;
      expect(expr.property).toBe("c");
      const mid = expr.object as PropertyAccess;
      expect(mid.property).toBe("b");
      expect((mid.object as Identifier).name).toBe("a");
    });

    it("parses .empty on variable", () => {
      const expr = parseExpr("result.empty") as PropertyAccess;
      expect(expr.property).toBe("empty");
    });
  });

  describe("Function calls as expressions", () => {
    it("parses contains()", () => {
      const expr = parseExpr('contains(url, "/api")') as StepCall;
      expect(expr.type).toBe("StepCall");
      expect(expr.name).toBe("contains");
      expect(expr.args).toHaveLength(2);
    });

    it("parses equals()", () => {
      const expr = parseExpr("equals(status, 200)") as StepCall;
      expect(expr.name).toBe("equals");
    });

    it("parses matches() with raw string", () => {
      const expr = parseExpr('matches(url, r"/users/\\d+")') as StepCall;
      expect(expr.name).toBe("matches");
    });

    it("parses len()", () => {
      const expr = parseExpr("len(items)") as StepCall;
      expect(expr.name).toBe("len");
    });
  });

  describe("Extraction expressions", () => {
    it("parses text(target)", () => {
      const expr = parseExpr('text(@css(".name"))') as ExtractionExpression;
      expect(expr.type).toBe("ExtractionExpression");
      expect(expr.kind).toBe("text");
    });

    it("parses attr(target, name)", () => {
      const expr = parseExpr('attr(@css("a"), "href")') as ExtractionExpression;
      expect(expr.type).toBe("ExtractionExpression");
      expect(expr.kind).toBe("attr");
      expect((expr.attribute as StringLiteral).value).toBe("href");
    });
  });
});

// ─── Block Sections ──────────────────────────────────────────

describe("Block Sections", () => {
  it("parses meta block", () => {
    const ast = parse(`
meta:
    id: "my-taskpack"
    name: "My Task Pack"
    version: "1.0.0"
    description: "Does something useful"
`);
    const meta = ast.blocks[0] as MetaBlock;
    expect(meta.type).toBe("MetaBlock");
    expect(meta.fields).toHaveLength(4);
    expect(meta.fields[0].name).toBe("id");
    expect((meta.fields[0].value as StringLiteral).value).toBe("my-taskpack");
  });

  it("parses inputs block with various types", () => {
    const ast = parse(`
inputs:
    username: string
    password: secret
    batch: string = "Winter 2024"
    max_results: number = 100
    headless: bool = true
`);
    const inputs = ast.blocks[0] as InputsBlock;
    expect(inputs.type).toBe("InputsBlock");
    expect(inputs.declarations).toHaveLength(5);
    expect(inputs.declarations[0].typeSpec).toBe("string");
    expect(inputs.declarations[0].defaultValue).toBeUndefined();
    expect(inputs.declarations[1].typeSpec).toBe("secret");
    expect(inputs.declarations[2].defaultValue).toBeDefined();
    expect((inputs.declarations[2].defaultValue as StringLiteral).value).toBe("Winter 2024");
    expect(inputs.declarations[3].typeSpec).toBe("number");
    expect(inputs.declarations[4].typeSpec).toBe("bool");
  });

  it("parses outputs block", () => {
    const ast = parse(`
outputs:
    page_title: string
    companies: array
    raw_data: object
`);
    const outputs = ast.blocks[0] as OutputsBlock;
    expect(outputs.type).toBe("OutputsBlock");
    expect(outputs.declarations).toHaveLength(3);
    expect(outputs.declarations[0].typeSpec).toBe("string");
    expect(outputs.declarations[1].typeSpec).toBe("array");
    expect(outputs.declarations[2].typeSpec).toBe("object");
  });

  it("parses all blocks together", () => {
    const ast = parse(`
meta:
    id: "test"
inputs:
    x: string
outputs:
    y: array
flow:
    goto("https://example.com")
`);
    expect(ast.blocks).toHaveLength(4);
    expect(ast.blocks[0].type).toBe("MetaBlock");
    expect(ast.blocks[1].type).toBe("InputsBlock");
    expect(ast.blocks[2].type).toBe("OutputsBlock");
    expect(ast.blocks[3].type).toBe("FlowBlock");
  });
});

// ─── Comments ────────────────────────────────────────────────

describe("Comments", () => {
  it("ignores comments", () => {
    const ast = parse(`
# This is a comment
flow:
    # Comment before step
    goto("https://example.com")
    # Comment after step
`);
    const flow = ast.blocks[0] as FlowBlock;
    expect(flow.statements).toHaveLength(1);
  });
});

// ─── Error Handling ──────────────────────────────────────────

describe("Error Handling", () => {
  it("throws ShowScriptSyntaxError on invalid syntax", () => {
    expect(() => parse("flow:\n    ???")).toThrow(ShowScriptSyntaxError);
  });

  it("includes location in error", () => {
    try {
      parse("flow:\n    ???");
      expect.fail("Should have thrown");
    } catch (e) {
      if (e instanceof ShowScriptSyntaxError) {
        expect(e.location).toBeDefined();
      }
    }
  });

  it("includes filename in error when provided", () => {
    try {
      parse("flow:\n    ???", { filename: "test.ss" });
      expect.fail("Should have thrown");
    } catch (e) {
      if (e instanceof ShowScriptSyntaxError) {
        expect(e.filename).toBe("test.ss");
        expect(e.message).toContain("test.ss");
      }
    }
  });
});

// ─── Complete Examples from Grammar Doc ──────────────────────

describe("Complete Examples", () => {
  it("Example 1: Simple Page Scrape", () => {
    const ast = parse(`
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
`);
    expect(ast.blocks).toHaveLength(3);
    const flow = ast.blocks[2] as FlowBlock;
    expect(flow.statements).toHaveLength(4);
  });

  it("Example 2: Login with Cookie Handling", () => {
    const ast = parse(`
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
`);
    expect(ast.blocks).toHaveLength(3);
    const flow = ast.blocks[2] as FlowBlock;
    expect(flow.statements).toHaveLength(8);
    // Check the if statement
    const ifStmt = flow.statements[1] as IfStatement;
    expect(ifStmt.type).toBe("IfStatement");
    expect(ifStmt.body).toHaveLength(1);
  });

  it("Example 3: Pagination with Network Replay", () => {
    const ast = parse(`
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

    companies = while (total_fetched < max_results) {
        result = network.replay(api_req, {
            auth: "browser",
            response: "json",
        })

        batch_companies = extract(result, path: "results[0].hits[*]")

        if (batch_companies.empty) {
            total_fetched = max_results + 1
        } else {
            total_fetched = total_fetched + len(batch_companies)
            page = page + 1
            yield batch_companies
        }
    }
`);
    expect(ast.blocks).toHaveLength(4);
    expect(ast.blocks[0].type).toBe("MetaBlock");
    const flow = ast.blocks[3] as FlowBlock;
    expect(flow.statements).toHaveLength(5);
    // Check while loop with assignTo
    const whileStmt = flow.statements[4] as WhileStatement;
    expect(whileStmt.type).toBe("WhileStatement");
    expect(whileStmt.assignTo).toBe("companies");
  });

  it("Example 4: Multi-Tab Price Comparison", () => {
    const ast = parse(`
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
`);
    expect(ast.blocks).toHaveLength(3);
    const flow = ast.blocks[2] as FlowBlock;
    expect(flow.statements).toHaveLength(12);
    // Check array assignment
    const pricesAssign = flow.statements[10] as AssignStatement;
    expect(pricesAssign.name).toBe("prices");
    expect(pricesAssign.value.type).toBe("ArrayLiteral");
  });

  it("Example 5: Retry Pattern", () => {
    const ast = parse(`
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
`);
    expect(ast.blocks).toHaveLength(3);
    const flow = ast.blocks[2] as FlowBlock;
    expect(flow.statements).toHaveLength(4);
    // Check while condition is compound
    const whileStmt = flow.statements[2] as WhileStatement;
    const cond = whileStmt.condition as BinaryExpression;
    expect(cond.operator).toBe("&&");
    // Check if/elif/else inside while
    const ifStmt = whileStmt.body[1] as IfStatement;
    expect(ifStmt.elifs).toHaveLength(1);
    expect(ifStmt.elseBody).toHaveLength(1);
  });
});

// ─── Source Locations ────────────────────────────────────────

describe("Source Locations", () => {
  it("includes location info on AST nodes", () => {
    const ast = parse('flow:\n    goto("https://example.com")');
    expect(ast.loc).toBeDefined();
    expect(ast.loc!.start.line).toBe(1);
    const flow = ast.blocks[0] as FlowBlock;
    expect(flow.loc).toBeDefined();
  });
});
