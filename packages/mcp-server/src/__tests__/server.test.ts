import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { inputSchemaToZodSchema } from '../server.js';
import type { InputSchema } from '@showrun/core';

describe('inputSchemaToZodSchema', () => {
  describe('string fields', () => {
    it('converts required string fields', () => {
      const schema: InputSchema = {
        name: { type: 'string', required: true },
      };
      const zodSchema = z.object(inputSchemaToZodSchema(schema));

      expect(zodSchema.parse({ name: 'John' })).toEqual({ name: 'John' });
      expect(() => zodSchema.parse({ name: 123 })).toThrow();
    });

    it('converts optional string fields', () => {
      const schema: InputSchema = {
        name: { type: 'string', required: false },
      };
      const zodSchema = z.object(inputSchemaToZodSchema(schema));

      expect(zodSchema.parse({})).toEqual({});
      expect(zodSchema.parse({ name: 'John' })).toEqual({ name: 'John' });
    });
  });

  describe('number fields', () => {
    it('converts required number fields', () => {
      const schema: InputSchema = {
        count: { type: 'number', required: true },
      };
      const zodSchema = z.object(inputSchemaToZodSchema(schema));

      expect(zodSchema.parse({ count: 42 })).toEqual({ count: 42 });
      expect(zodSchema.parse({ count: 3.14 })).toEqual({ count: 3.14 });
      expect(() => zodSchema.parse({ count: '42' })).toThrow();
    });

    it('converts optional number fields', () => {
      const schema: InputSchema = {
        count: { type: 'number', required: false },
      };
      const zodSchema = z.object(inputSchemaToZodSchema(schema));

      expect(zodSchema.parse({})).toEqual({});
      expect(zodSchema.parse({ count: 10 })).toEqual({ count: 10 });
    });
  });

  describe('boolean fields', () => {
    it('converts required boolean fields', () => {
      const schema: InputSchema = {
        enabled: { type: 'boolean', required: true },
      };
      const zodSchema = z.object(inputSchemaToZodSchema(schema));

      expect(zodSchema.parse({ enabled: true })).toEqual({ enabled: true });
      expect(zodSchema.parse({ enabled: false })).toEqual({ enabled: false });
      expect(() => zodSchema.parse({ enabled: 'true' })).toThrow();
    });

    it('converts optional boolean fields', () => {
      const schema: InputSchema = {
        enabled: { type: 'boolean', required: false },
      };
      const zodSchema = z.object(inputSchemaToZodSchema(schema));

      expect(zodSchema.parse({})).toEqual({});
      expect(zodSchema.parse({ enabled: true })).toEqual({ enabled: true });
    });
  });

  describe('mixed schemas', () => {
    it('handles multiple fields of different types', () => {
      const schema: InputSchema = {
        name: { type: 'string', required: true },
        age: { type: 'number', required: true },
        active: { type: 'boolean', required: false },
      };
      const zodSchema = z.object(inputSchemaToZodSchema(schema));

      expect(zodSchema.parse({ name: 'Alice', age: 30 })).toEqual({ name: 'Alice', age: 30 });
      expect(zodSchema.parse({ name: 'Bob', age: 25, active: true })).toEqual({
        name: 'Bob',
        age: 25,
        active: true,
      });
    });

    it('fails when required fields are missing', () => {
      const schema: InputSchema = {
        name: { type: 'string', required: true },
        age: { type: 'number', required: true },
      };
      const zodSchema = z.object(inputSchemaToZodSchema(schema));

      expect(() => zodSchema.parse({ name: 'Alice' })).toThrow();
      expect(() => zodSchema.parse({ age: 30 })).toThrow();
      expect(() => zodSchema.parse({})).toThrow();
    });
  });

  describe('descriptions', () => {
    it('adds description to field when provided', () => {
      const schema: InputSchema = {
        email: { type: 'string', required: true, description: 'User email address' },
      };
      const zodShape = inputSchemaToZodSchema(schema);

      expect(zodShape.email.description).toBe('User email address');
    });

    it('does not add description when not provided', () => {
      const schema: InputSchema = {
        email: { type: 'string', required: true },
      };
      const zodShape = inputSchemaToZodSchema(schema);

      expect(zodShape.email.description).toBeUndefined();
    });
  });

  describe('empty schema', () => {
    it('handles empty input schema', () => {
      const schema: InputSchema = {};
      const zodSchema = z.object(inputSchemaToZodSchema(schema));

      expect(zodSchema.parse({})).toEqual({});
    });
  });
});
