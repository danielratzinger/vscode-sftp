/**
 * Enough of JSON Schema to hold the tools to what they publish.
 *
 * A tool that declares an output schema is telling the client to read the
 * structured half of the reply and ignore the text - which is what a client
 * does. `read` declared one and put the file only in the text, so a real
 * client received the path, the state and the timestamps of a file whose
 * contents it never saw, and every test passed because every test read the
 * text.
 */

export function validate(value: any, schema: any, where: string): string[] {
  const wrong: string[] = [];

  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return [`${where}: expected an object, got ${JSON.stringify(value)}`];
    }

    Object.keys(schema.properties || {}).forEach(name => {
      // Absent is allowed - a tool says nothing about a local copy that is not
      // there. Present and the wrong shape is not.
      if (value[name] !== undefined && value[name] !== null) {
        wrong.push(...validate(value[name], schema.properties[name], `${where}.${name}`));
      }
    });

    (schema.required || []).forEach((name: string) => {
      if (value[name] === undefined) {
        wrong.push(`${where}: required property ${name} is missing`);
      }
    });

    // Extra keys are how a reply drifts from what the schema promises; a
    // client validating strictly would reject them.
    Object.keys(value).forEach(name => {
      if (!(schema.properties || {})[name]) {
        wrong.push(`${where}: returned ${name}, which the schema does not declare`);
      }
    });

    return wrong;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      return [`${where}: expected an array, got ${typeof value}`];
    }
    value.forEach((item, at) =>
      wrong.push(...validate(item, schema.items, `${where}[${at}]`))
    );
    return wrong;
  }

  const kinds: { [name: string]: string } = {
    string: 'string',
    number: 'number',
    integer: 'number',
    boolean: 'boolean',
  };
  const expected = kinds[schema.type];
  if (expected && typeof value !== expected) {
    wrong.push(`${where}: expected ${schema.type}, got ${typeof value} (${value})`);
  }

  return wrong;
}

