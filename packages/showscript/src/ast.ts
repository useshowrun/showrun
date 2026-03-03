/** Source location information for AST nodes */
export interface SourceLocation {
  start: { offset: number; line: number; column: number };
  end: { offset: number; line: number; column: number };
}

/** Base interface for all AST nodes */
export interface BaseNode {
  type: string;
  loc?: SourceLocation;
}

// ─── Top-Level ───────────────────────────────────────────────

export interface Program extends BaseNode {
  type: "Program";
  blocks: BlockSection[];
}

export type BlockSection = MetaBlock | InputsBlock | OutputsBlock | FlowBlock;

// ─── Meta Block ──────────────────────────────────────────────

export interface MetaBlock extends BaseNode {
  type: "MetaBlock";
  fields: MetaField[];
}

export interface MetaField extends BaseNode {
  type: "MetaField";
  name: string;
  value: Literal;
}

// ─── Inputs/Outputs Blocks ───────────────────────────────────

export interface InputsBlock extends BaseNode {
  type: "InputsBlock";
  declarations: InputDeclaration[];
}

export interface InputDeclaration extends BaseNode {
  type: "InputDeclaration";
  name: string;
  typeSpec: TypeSpec;
  defaultValue?: Expression;
}

export type TypeSpec = "string" | "number" | "bool" | "secret" | "array" | "object";

export interface OutputsBlock extends BaseNode {
  type: "OutputsBlock";
  declarations: OutputDeclaration[];
}

export interface OutputDeclaration extends BaseNode {
  type: "OutputDeclaration";
  name: string;
  typeSpec: TypeSpec;
}

// ─── Flow Block ──────────────────────────────────────────────

export interface FlowBlock extends BaseNode {
  type: "FlowBlock";
  statements: Statement[];
}

// ─── Statements ──────────────────────────────────────────────

export type Statement = StepStatement | AssignStatement | IfStatement | WhileStatement | ForStatement | YieldStatement;

export interface StepStatement extends BaseNode {
  type: "StepStatement";
  call: StepCall;
}

export interface AssignStatement extends BaseNode {
  type: "AssignStatement";
  name: string;
  value: Expression;
}

export interface YieldStatement extends BaseNode {
  type: "YieldStatement";
  value: Expression;
}

// ─── Control Flow ────────────────────────────────────────────

export interface IfStatement extends BaseNode {
  type: "IfStatement";
  condition: Expression;
  body: Statement[];
  elifs: ElifClause[];
  elseBody?: Statement[];
}

export interface ElifClause extends BaseNode {
  type: "ElifClause";
  condition: Expression;
  body: Statement[];
}

export interface WhileStatement extends BaseNode {
  type: "WhileStatement";
  assignTo?: string;
  condition: Expression;
  body: Statement[];
}

export interface ForStatement extends BaseNode {
  type: "ForStatement";
  assignTo?: string;
  variable: string;
  iterable: RangeExpression | Identifier | PropertyAccess;
  body: Statement[];
}

export interface RangeExpression extends BaseNode {
  type: "RangeExpression";
  start: Expression;
  end: Expression;
}

// ─── Expressions ─────────────────────────────────────────────

export type Expression =
  | Literal
  | StringLiteral
  | FString
  | RawString
  | NumberLiteral
  | BooleanLiteral
  | NullLiteral
  | DurationLiteral
  | ArrayLiteral
  | ObjectLiteral
  | Identifier
  | PropertyAccess
  | TargetExpression
  | StepCall
  | ExtractionExpression
  | BinaryExpression
  | UnaryExpression
  | GroupExpression
  | WhileStatement
  | ForStatement;

// ─── Literals ────────────────────────────────────────────────

export type Literal =
  | StringLiteral
  | NumberLiteral
  | BooleanLiteral
  | NullLiteral
  | DurationLiteral
  | ArrayLiteral
  | ObjectLiteral;

export interface StringLiteral extends BaseNode {
  type: "StringLiteral";
  value: string;
  quote: "'" | '"';
}

export interface FString extends BaseNode {
  type: "FString";
  parts: FStringPart[];
  quote: "'" | '"';
}

export type FStringPart = FStringText | FStringInterpolation;

export interface FStringText extends BaseNode {
  type: "FStringText";
  value: string;
}

export interface FStringInterpolation extends BaseNode {
  type: "FStringInterpolation";
  identifier: string;
  filters: Filter[];
}

export interface Filter extends BaseNode {
  type: "Filter";
  name: string;
  argument?: Literal;
}

export interface RawString extends BaseNode {
  type: "RawString";
  value: string;
  quote: "'" | '"';
}

export interface NumberLiteral extends BaseNode {
  type: "NumberLiteral";
  value: number;
}

export interface BooleanLiteral extends BaseNode {
  type: "BooleanLiteral";
  value: boolean;
}

export interface NullLiteral extends BaseNode {
  type: "NullLiteral";
}

export interface DurationLiteral extends BaseNode {
  type: "DurationLiteral";
  value: number;
  unit: "s" | "ms" | "m";
}

export interface ArrayLiteral extends BaseNode {
  type: "ArrayLiteral";
  elements: Expression[];
}

export interface ObjectLiteral extends BaseNode {
  type: "ObjectLiteral";
  fields: ObjectField[];
}

export interface ObjectField extends BaseNode {
  type: "ObjectField";
  key: string;
  value: Expression;
}

// ─── Identifiers & Property Access ───────────────────────────

export interface Identifier extends BaseNode {
  type: "Identifier";
  name: string;
}

export interface PropertyAccess extends BaseNode {
  type: "PropertyAccess";
  object: Identifier | PropertyAccess;
  property: string;
}

// ─── Target Expressions ──────────────────────────────────────

export interface TargetExpression extends BaseNode {
  type: "TargetExpression";
  target: TargetPrimary | AnyTarget;
  modifiers: TargetModifier[];
  property?: string;
}

export type TargetType = "css" | "text" | "role" | "label" | "attr";

export interface TargetPrimary extends BaseNode {
  type: "TargetPrimary";
  targetType: TargetType;
  args: Argument[];
}

export interface AnyTarget extends BaseNode {
  type: "AnyTarget";
  targets: TargetExpression[];
}

export interface TargetModifier extends BaseNode {
  type: "TargetModifier";
  kind: "in" | "near";
  target: TargetExpression;
}

// ─── Step Calls ──────────────────────────────────────────────

export interface StepCall extends BaseNode {
  type: "StepCall";
  name: string;
  args: Argument[];
}

export type Argument = PositionalArgument | NamedArgument;

export interface PositionalArgument extends BaseNode {
  type: "PositionalArgument";
  value: Expression;
}

export interface NamedArgument extends BaseNode {
  type: "NamedArgument";
  name: string;
  value: Expression;
}

// ─── Extraction Expressions ──────────────────────────────────

export interface ExtractionExpression extends BaseNode {
  type: "ExtractionExpression";
  kind: "text" | "attr";
  target: TargetExpression;
  attribute?: Expression;
}

// ─── Binary & Unary Expressions ──────────────────────────────

export type BinaryOperator =
  | "+" | "-" | "*" | "/" | "%"
  | "==" | "!=" | ">" | "<" | ">=" | "<="
  | "&&" | "||";

export interface BinaryExpression extends BaseNode {
  type: "BinaryExpression";
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
}

export type UnaryOperator = "-" | "!";

export interface UnaryExpression extends BaseNode {
  type: "UnaryExpression";
  operator: UnaryOperator;
  operand: Expression;
}

export interface GroupExpression extends BaseNode {
  type: "GroupExpression";
  expression: Expression;
}
