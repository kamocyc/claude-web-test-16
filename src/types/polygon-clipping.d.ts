/**
 * `polygon-clipping`'s shipped `.d.ts` declares only named exports, but its ESM
 * build (`dist/polygon-clipping.esm.js`) ends with `export { index as default }`
 * and provides no named bindings at all. Importing the named exports would
 * typecheck and then fail at bundle time.
 *
 * Ambient `declare module` blocks merge, so this adds the default export that
 * actually exists. `geom/boolean.ts` is the only file that imports it.
 */
declare module 'polygon-clipping' {
  const polygonClipping: {
    intersection(geom: Geom, ...geoms: Geom[]): MultiPolygon;
    xor(geom: Geom, ...geoms: Geom[]): MultiPolygon;
    union(geom: Geom, ...geoms: Geom[]): MultiPolygon;
    difference(subjectGeom: Geom, ...clipGeoms: Geom[]): MultiPolygon;
  };
  export default polygonClipping;
}
