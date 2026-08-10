import { describe, it, expect } from 'vitest';
import {
  applySchemaTextDefault,
  applyTemplateTextDefaultsToPages,
} from '../../../src/utils/webhookTemplateHelpers.js';

describe('applySchemaTextDefault', () => {
  it('ignores a schema with no name', () => {
    const inputs = {};
    applySchemaTextDefault({ type: 'text', content: 'hi' }, inputs);
    applySchemaTextDefault(null, inputs);
    applySchemaTextDefault(undefined, inputs);
    expect(inputs).toEqual({});
  });

  it('does not overwrite a name already present in the inputs', () => {
    const inputs = { title: 'existing' };
    applySchemaTextDefault({ name: 'title', type: 'text', content: 'default' }, inputs);
    expect(inputs.title).toBe('existing');
  });

  it('treats an explicit empty string as present and leaves it alone', () => {
    const inputs = { title: '' };
    applySchemaTextDefault({ name: 'title', type: 'text', content: 'default' }, inputs);
    expect(inputs.title).toBe('');
  });

  it('defaults a text schema to its string content', () => {
    const inputs = {};
    applySchemaTextDefault({ name: 'title', type: 'text', content: 'Invoice' }, inputs);
    expect(inputs.title).toBe('Invoice');
  });

  it('defaults a text schema with non-string content to an empty string', () => {
    const inputs = {};
    applySchemaTextDefault({ name: 'title', type: 'text', content: { a: 1 } }, inputs);
    expect(inputs.title).toBe('');
  });

  it('defaults a multiVariableText schema with non-string content to "{}"', () => {
    const inputs = {};
    applySchemaTextDefault({ name: 'rows', type: 'multiVariableText' }, inputs);
    expect(inputs.rows).toBe('{}');
  });

  it('defaults a multiVariableText schema to its string content', () => {
    const inputs = {};
    applySchemaTextDefault(
      { name: 'rows', type: 'multiVariableText', content: '{"a":"b"}' },
      inputs,
    );
    expect(inputs.rows).toBe('{"a":"b"}');
  });

  it('leaves unrelated schema types untouched', () => {
    const inputs = {};
    applySchemaTextDefault({ name: 'logo', type: 'image', content: 'data:...' }, inputs);
    expect(inputs).toEqual({});
  });
});

describe('applyTemplateTextDefaultsToPages', () => {
  it('does nothing when pages is not an array', () => {
    const inputs = {};
    applyTemplateTextDefaultsToPages(null, inputs);
    applyTemplateTextDefaultsToPages(undefined, inputs);
    applyTemplateTextDefaultsToPages('nope', inputs);
    expect(inputs).toEqual({});
  });

  it('skips page entries that are not arrays', () => {
    const inputs = {};
    applyTemplateTextDefaultsToPages([null, 'x', [{ name: 'a', type: 'text', content: 'A' }]], inputs);
    expect(inputs).toEqual({ a: 'A' });
  });

  it('applies defaults across every page', () => {
    const inputs = { b: 'kept' };
    applyTemplateTextDefaultsToPages(
      [
        [{ name: 'a', type: 'text', content: 'A' }],
        [
          { name: 'b', type: 'text', content: 'B' },
          { name: 'c', type: 'multiVariableText', content: '{"x":1}' },
        ],
      ],
      inputs,
    );
    expect(inputs).toEqual({ a: 'A', b: 'kept', c: '{"x":1}' });
  });
});
