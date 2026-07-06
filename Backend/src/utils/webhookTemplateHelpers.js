export function applySchemaTextDefault(schema, templateInputs) {
  if (!schema?.name) return;
  if (templateInputs[schema.name] !== undefined) return;
  if (schema.type === 'text') {
    templateInputs[schema.name] = typeof schema.content === 'string' ? schema.content : '';
  }
  if (schema.type === 'multiVariableText') {
    templateInputs[schema.name] = typeof schema.content === 'string' ? schema.content : '{}';
  }
}

export function applyTemplateTextDefaultsToPages(pages, templateInputs) {
  if (!Array.isArray(pages)) return;
  for (const pageSchemas of pages) {
    if (!Array.isArray(pageSchemas)) continue;
    for (const schema of pageSchemas) {
      applySchemaTextDefault(schema, templateInputs);
    }
  }
}
