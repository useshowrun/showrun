// ShowScript PEG Grammar
// Produces AST matching the types in ast.ts

{{
  function buildBinaryExpr(head, tail, loc) {
    return tail.reduce((left, [, op, , right]) => ({
      type: "BinaryExpression",
      operator: op,
      left,
      right,
      loc,
    }), head);
  }
}}

// ─── Top Level ───────────────────────────────────────────────

Program
  = blocks:(_ b:BlockSection { return b; })* _ {
    return { type: "Program", blocks, loc: location() };
  }

BlockSection
  = MetaBlock
  / InputsBlock
  / OutputsBlock
  / FlowBlock

// ─── Meta Block ──────────────────────────────────────────────

MetaBlock
  = "meta" _ ":" fields:MetaField* {
    return { type: "MetaBlock", fields, loc: location() };
  }

MetaField
  = _ name:Identifier_name _ ":" _ value:Literal {
    return { type: "MetaField", name, value, loc: location() };
  }

// ─── Inputs Block ────────────────────────────────────────────

InputsBlock
  = "inputs" _ ":" decls:InputDecl* {
    return { type: "InputsBlock", declarations: decls, loc: location() };
  }

InputDecl
  = _ name:Identifier_name _ ":" _ ts:TypeSpec def:(_ "=" _ e:Expression { return e; })? {
    return {
      type: "InputDeclaration",
      name,
      typeSpec: ts,
      ...(def != null ? { defaultValue: def } : {}),
      loc: location(),
    };
  }

TypeSpec
  = ts:$("string" / "secret" / "number" / "bool" / "array" / "object") !IdentContinue {
    return ts;
  }

// ─── Outputs Block ───────────────────────────────────────────

OutputsBlock
  = "outputs" _ ":" decls:OutputDecl* {
    return { type: "OutputsBlock", declarations: decls, loc: location() };
  }

OutputDecl
  = _ name:Identifier_name _ ":" _ ts:TypeSpec {
    return { type: "OutputDeclaration", name, typeSpec: ts, loc: location() };
  }

// ─── Flow Block ──────────────────────────────────────────────

FlowBlock
  = "flow" _ ":" stmts:Statement* {
    return { type: "FlowBlock", statements: stmts, loc: location() };
  }

// ─── Statements ──────────────────────────────────────────────

Statement
  = _ s:(ControlStmt / YieldStmt / AssignOrStepStmt) { return s; }

AssignOrStepStmt
  = name:Identifier_name _ "=" _ value:Expression {
    return { type: "AssignStatement", name, value, loc: location() };
  }
  / call:StepCall {
    return { type: "StepStatement", call, loc: location() };
  }

YieldStmt
  = "yield" !IdentContinue _ value:Expression {
    return { type: "YieldStatement", value, loc: location() };
  }

// ─── Control Flow ────────────────────────────────────────────

ControlStmt
  = IfStmt / WhileStmt / ForStmt

IfStmt
  = "if" !IdentContinue _ "(" _ cond:Expression _ ")" _ body:Block
    elifs:ElifClause*
    elseBody:ElseClause? {
    return {
      type: "IfStatement",
      condition: cond,
      body,
      elifs,
      ...(elseBody ? { elseBody } : {}),
      loc: location(),
    };
  }

ElifClause
  = _ "elif" !IdentContinue _ "(" _ c:Expression _ ")" _ b:Block {
    return { type: "ElifClause", condition: c, body: b, loc: location() };
  }

ElseClause
  = _ "else" !IdentContinue _ b:Block { return b; }

WhileStmt
  = assignTo:(name:Identifier_name _ "=" _ { return name; })?
    "while" !IdentContinue _ "(" _ cond:Expression _ ")" _ body:Block {
    return {
      type: "WhileStatement",
      ...(assignTo != null ? { assignTo } : {}),
      condition: cond,
      body,
      loc: location(),
    };
  }

ForStmt
  = assignTo:(name:Identifier_name _ "=" _ { return name; })?
    "for" !IdentContinue _ "(" _ variable:Identifier_name _ "in" !IdentContinue _ iter:Iterable _ ")" _ body:Block {
    return {
      type: "ForStatement",
      ...(assignTo != null ? { assignTo } : {}),
      variable,
      iterable: iter,
      body,
      loc: location(),
    };
  }

Iterable
  = "range" !IdentContinue _ "(" _ start:Expression _ "," _ end:Expression _ ")" {
    return { type: "RangeExpression", start, end, loc: location() };
  }
  / name:Identifier_name props:("." prop:Identifier_name { return prop; })* {
    if (props.length === 0) {
      return { type: "Identifier", name, loc: location() };
    }
    let result = { type: "Identifier", name, loc: location() };
    for (const p of props) {
      result = { type: "PropertyAccess", object: result, property: p, loc: location() };
    }
    return result;
  }

Block
  = "{" stmts:Statement* _ "}" {
    return stmts;
  }

// ─── Expressions (precedence climbing) ──────────────────────

Expression
  = OrExpr

OrExpr
  = head:AndExpr tail:(_ "||" _ AndExpr)* {
    return buildBinaryExpr(head, tail, location());
  }

AndExpr
  = head:ComparisonExpr tail:(_ "&&" _ ComparisonExpr)* {
    return buildBinaryExpr(head, tail, location());
  }

ComparisonExpr
  = left:AdditiveExpr _ op:CompareOp _ right:AdditiveExpr {
    return { type: "BinaryExpression", operator: op, left, right, loc: location() };
  }
  / AdditiveExpr

CompareOp
  = "==" / "!=" / ">=" / "<=" / ">" / "<"

AdditiveExpr
  = head:MultiplicativeExpr tail:(_ op:("+" / "-") _ right:MultiplicativeExpr { return [null, op, null, right]; })* {
    return buildBinaryExpr(head, tail, location());
  }

MultiplicativeExpr
  = head:UnaryExpr tail:(_ op:("*" / "/" / "%") _ right:UnaryExpr { return [null, op, null, right]; })* {
    return buildBinaryExpr(head, tail, location());
  }

UnaryExpr
  = "!" _ operand:UnaryExpr {
    return { type: "UnaryExpression", operator: "!", operand, loc: location() };
  }
  / "-" _ operand:UnaryExpr {
    return { type: "UnaryExpression", operator: "-", operand, loc: location() };
  }
  / PrimaryExpr

PrimaryExpr
  = DurationLiteral
  / NumberLiteral
  / BooleanLiteral
  / NullLiteral
  / FStringLiteral
  / RawStringLiteral
  / StringLiteral
  / ArrayLiteral
  / ObjectLiteral
  / TargetExpr
  / ExtractionExpr
  / LoopExpr
  / StepCallOrPropertyOrIdent
  / GroupExpr

GroupExpr
  = "(" _ expr:Expression _ ")" {
    return { type: "GroupExpression", expression: expr, loc: location() };
  }

LoopExpr
  = WhileStmt
  / ForStmt

// ─── Disambiguation: step_call vs property_access vs identifier ──

StepCallOrPropertyOrIdent
  = name:Identifier_name rest:("." prop:Identifier_name { return prop; })* &(_ "(") _ "(" _ args:ArgList? _ ")" {
    const fullName = [name, ...rest].join(".");
    return {
      type: "StepCall",
      name: fullName,
      args: args || [],
      loc: location(),
    };
  }
  / name:Identifier_name rest:("." prop:Identifier_name { return prop; })+ {
    let result = { type: "Identifier", name, loc: location() };
    for (const p of rest) {
      result = { type: "PropertyAccess", object: result, property: p, loc: location() };
    }
    return result;
  }
  / name:Identifier_name {
    return { type: "Identifier", name, loc: location() };
  }

// Step call (used from statements)
StepCall
  = name:Identifier_name rest:("." prop:Identifier_name { return prop; })* _ "(" _ args:ArgList? _ ")" {
    const fullName = [name, ...rest].join(".");
    return {
      type: "StepCall",
      name: fullName,
      args: args || [],
      loc: location(),
    };
  }

// ─── Arguments ───────────────────────────────────────────────

ArgList
  = head:Arg tail:(_ "," _ a:Arg { return a; })* _ ","? {
    return [head, ...tail];
  }

Arg
  = NamedArg / PositionalArg

NamedArg
  = name:Identifier_name _ ":" _ value:Expression {
    return { type: "NamedArgument", name, value, loc: location() };
  }

PositionalArg
  = value:Expression {
    return { type: "PositionalArgument", value, loc: location() };
  }

// ─── Target Expressions ─────────────────────────────────────

TargetExpr
  = target:TargetPrimary modifiers:TargetModifier* prop:("." prop:Identifier_name !(_ "(") { return prop; })? {
    return {
      type: "TargetExpression",
      target,
      modifiers,
      ...(prop != null ? { property: prop } : {}),
      loc: location(),
    };
  }

TargetPrimary
  = "@any" _ "(" _ head:TargetExpr tail:(_ "," _ t:TargetExpr { return t; })* _ ","? _ ")" {
    return {
      type: "AnyTarget",
      targets: [head, ...tail],
      loc: location(),
    };
  }
  / "@" tt:TargetType _ "(" _ args:ArgList? _ ")" {
    return {
      type: "TargetPrimary",
      targetType: tt,
      args: args || [],
      loc: location(),
    };
  }

TargetType
  = "css" { return "css"; }
  / "text" { return "text"; }
  / "role" { return "role"; }
  / "label" { return "label"; }
  / "attr" { return "attr"; }

TargetModifier
  = "." kind:("in" / "near") !IdentContinue _ "(" _ target:TargetExpr _ ")" {
    return { type: "TargetModifier", kind, target, loc: location() };
  }

// ─── Extraction Expressions ──────────────────────────────────

ExtractionExpr
  = "text" !IdentContinue _ "(" _ target:TargetExpr _ ")" {
    return { type: "ExtractionExpression", kind: "text", target, loc: location() };
  }
  / "attr" !IdentContinue _ "(" _ target:TargetExpr _ "," _ attribute:StringExpr _ ")" {
    return { type: "ExtractionExpression", kind: "attr", target, attribute, loc: location() };
  }

StringExpr
  = FStringLiteral / RawStringLiteral / StringLiteral

// ─── Literals ────────────────────────────────────────────────

Literal
  = DurationLiteral
  / NumberLiteral
  / BooleanLiteral
  / NullLiteral
  / StringLiteral
  / ArrayLiteral
  / ObjectLiteral

DurationLiteral
  = value:NumberValue unit:("ms" / "s" / "m") !IdentContinue {
    return { type: "DurationLiteral", value, unit, loc: location() };
  }

NumberLiteral
  = value:NumberValue !("ms" / "s" / "m" !IdentContinue) {
    return { type: "NumberLiteral", value, loc: location() };
  }

NumberValue
  = digits:$([0-9]+ ("." [0-9]+)?) {
    return parseFloat(digits);
  }

BooleanLiteral
  = "true" !IdentContinue { return { type: "BooleanLiteral", value: true, loc: location() }; }
  / "false" !IdentContinue { return { type: "BooleanLiteral", value: false, loc: location() }; }

NullLiteral
  = "null" !IdentContinue { return { type: "NullLiteral", loc: location() }; }

StringLiteral
  = '"' chars:DoubleStringChar* '"' {
    return { type: "StringLiteral", value: chars.join(""), quote: '"', loc: location() };
  }
  / "'" chars:SingleStringChar* "'" {
    return { type: "StringLiteral", value: chars.join(""), quote: "'", loc: location() };
  }

DoubleStringChar
  = "\\" seq:EscapeSequence { return seq; }
  / [^"\\]

SingleStringChar
  = "\\" seq:EscapeSequence { return seq; }
  / [^'\\]

EscapeSequence
  = "n" { return "\n"; }
  / "t" { return "\t"; }
  / "\\" { return "\\"; }
  / '"' { return '"'; }
  / "'" { return "'"; }

FStringLiteral
  = "f\"" parts:FStringDoublePart* "\"" {
    return { type: "FString", parts, quote: '"', loc: location() };
  }
  / "f'" parts:FStringSinglePart* "'" {
    return { type: "FString", parts, quote: "'", loc: location() };
  }

FStringDoublePart
  = "{" _ id:Identifier_name filters:(_ "|" _ f:Filter { return f; })* _ "}" {
    return {
      type: "FStringInterpolation",
      identifier: id,
      filters,
      loc: location(),
    };
  }
  / chars:FStringDoubleText+ {
    return { type: "FStringText", value: chars.join(""), loc: location() };
  }

FStringDoubleText
  = "\\" seq:EscapeSequence { return seq; }
  / [^"\\{]

FStringSinglePart
  = "{" _ id:Identifier_name filters:(_ "|" _ f:Filter { return f; })* _ "}" {
    return {
      type: "FStringInterpolation",
      identifier: id,
      filters,
      loc: location(),
    };
  }
  / chars:FStringSingleText+ {
    return { type: "FStringText", value: chars.join(""), loc: location() };
  }

FStringSingleText
  = "\\" seq:EscapeSequence { return seq; }
  / [^'\\{]

Filter
  = name:Identifier_name arg:(_ ":" _ l:Literal { return l; })? {
    return {
      type: "Filter",
      name,
      ...(arg != null ? { argument: arg } : {}),
      loc: location(),
    };
  }

RawStringLiteral
  = "r\"" chars:[^"]* "\"" {
    return { type: "RawString", value: chars.join(""), quote: '"', loc: location() };
  }
  / "r'" chars:[^']* "'" {
    return { type: "RawString", value: chars.join(""), quote: "'", loc: location() };
  }

ArrayLiteral
  = "[" _ "]" {
    return { type: "ArrayLiteral", elements: [], loc: location() };
  }
  / "[" _ head:Expression tail:(_ "," _ e:Expression { return e; })* _ ","? _ "]" {
    return {
      type: "ArrayLiteral",
      elements: [head, ...tail],
      loc: location(),
    };
  }

ObjectLiteral
  = "{" _ "}" {
    return { type: "ObjectLiteral", fields: [], loc: location() };
  }
  / "{" _ head:ObjectFieldRule tail:(_ "," _ f:ObjectFieldRule { return f; })* _ ","? _ "}" {
    return {
      type: "ObjectLiteral",
      fields: [head, ...tail],
      loc: location(),
    };
  }

ObjectFieldRule
  = key:Identifier_name _ ":" _ value:Expression {
    return { type: "ObjectField", key, value, loc: location() };
  }

// ─── Identifiers ─────────────────────────────────────────────

Identifier_name "identifier"
  = !Reserved id:$([a-zA-Z_][a-zA-Z0-9_]*) { return id; }

IdentContinue
  = [a-zA-Z0-9_]

Reserved
  = ("if" / "elif" / "else" / "while" / "for" / "in" / "yield" / "range"
     / "true" / "false" / "null"
     / "meta" / "inputs" / "outputs" / "flow") !IdentContinue

// ─── Whitespace ──────────────────────────────────────────────

_ "whitespace"
  = ([ \t\n\r] / Comment)*

Comment
  = "#" [^\n]*
