import type { InputSchema, PrimitiveType } from './types.js';

/**
 * Validates inputs against a schema
 */
export class InputValidator {
  /**
   * Apply default values from schema to inputs.
   * Returns a new object with defaults applied for missing fields.
   */
  static applyDefaults(inputs: Record<string, unknown>, schema: InputSchema): Record<string, unknown> {
    const result = { ...inputs };
    for (const [fieldName, fieldDef] of Object.entries(schema)) {
      if (!(fieldName in result) && fieldDef.default !== undefined) {
        result[fieldName] = fieldDef.default;
      }
    }
    return result;
  }

  /**
   * Validate inputs against schema
   */
  static validate(inputs: Record<string, unknown>, schema: InputSchema): void {
    const errors: string[] = [];

    // Check required fields
    for (const [fieldName, fieldDef] of Object.entries(schema)) {
      if (fieldDef.required && !(fieldName in inputs)) {
        errors.push(`Missing required field: ${fieldName}`);
      }
    }

    // Check field types
    for (const [fieldName, value] of Object.entries(inputs)) {
      if (!(fieldName in schema)) {
        errors.push(`Unknown field: ${fieldName}`);
        continue;
      }

      const fieldDef = schema[fieldName];
      const typeError = this.validateType(fieldName, value, fieldDef.type);
      if (typeError) {
        errors.push(typeError);
      }
    }

    if (errors.length > 0) {
      throw new Error(`Input validation failed:\n${errors.join('\n')}`);
    }
  }

  /**
   * Validate a single value against a type
   */
  private static validateType(fieldName: string, value: unknown, expectedType: PrimitiveType): string | null {
    switch (expectedType) {
      case 'string':
        if (typeof value !== 'string') {
          return `Field ${fieldName} must be a string, got ${typeof value}`;
        }
        break;
      case 'number':
        if (typeof value !== 'number') {
          return `Field ${fieldName} must be a number, got ${typeof value}`;
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          return `Field ${fieldName} must be a boolean, got ${typeof value}`;
        }
        break;
    }
    return null;
  }
}
