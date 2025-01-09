import { XMLBuilder } from "fast-xml-parser";

const allowedAttributes = [
  "path",
  "required",
  "type",
  "dependencies",
  "description",
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
