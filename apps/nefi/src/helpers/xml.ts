import { XMLBuilder } from "fast-xml-parser";

const allowedAttributes = [
  "path",
  "required",
  "type",
  "why",
  "dependencies",
  "description",
  "allows_multiple",
  "confidence",
  "allowed_functions",
  "hooks",
  "script",
  "priority",
  "reason",
  "name",
  "version",
  "count",
  "total",
  "timestamp",
  "format",
  "key",
  "type",
];

export const xml = {
  build: (obj: any) =>
    new XMLBuilder({
      ignoreAttributes: (attribute) => !allowedAttributes.includes(attribute),
      suppressEmptyNode: true,
      suppressUnpairedNode: true,
      processEntities: false,
      suppressBooleanAttributes: true,
      cdataPropName: false,
    }).build(obj),
};
