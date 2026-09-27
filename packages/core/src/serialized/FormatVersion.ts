// Ported from AssetStudio/SerializedFileFormatVersion.cs (MIT, © Perfare / RazTools / Razviar)

/**
 * SerializedFile format versions that change the byte layout, by upstream's
 * names. Every version gate in the reader compares against one of these, so
 * the gate says what it is about rather than which number it is.
 *
 * The Unity release that first wrote each version is noted where upstream
 * knows it. Only 21 and 22 have fixtures (#82); the rest are ported, untested.
 */
export const SerializedFileFormatVersion = {
  /** Upstream's marker for "too old to read"; nothing below 2 is parsed. */
  Unsupported: 1,
  Unknown_2: 2,
  Unknown_3: 3,
  /** 1.2.0 to 2.0.0 */
  Unknown_5: 5,
  /** 2.1.0 to 2.6.1 */
  Unknown_6: 6,
  /** 3.0.0b */
  Unknown_7: 7,
  /** 3.0.0 to 3.4.2 */
  Unknown_8: 8,
  /** 3.5.0 to 4.7.2 */
  Unknown_9: 9,
  /** 5.0.0aunk1 */
  Unknown_10: 10,
  /** 5.0.0aunk2 */
  HasScriptTypeIndex: 11,
  /** 5.0.0aunk3 */
  Unknown_12: 12,
  /** 5.0.0aunk4 */
  HasTypeTreeHashes: 13,
  /** 5.0.0unk */
  Unknown_14: 14,
  /** 5.0.1 to 5.4.0 */
  SupportsStrippedObject: 15,
  /** 5.5.0a */
  RefactoredClassId: 16,
  /** 5.5.0unk to 2018.4 */
  RefactorTypeData: 17,
  /** 2019.1a */
  RefactorShareableTypeTreeData: 18,
  /** 2019.1unk */
  TypeTreeNodeWithTypeFlags: 19,
  /** 2019.2 */
  SupportsRefObject: 20,
  /** 2019.3 to 2019.4 */
  StoresTypeDependencies: 21,
  /** 2020.1 to 6000.x */
  LargeFilesSupport: 22,
} as const;
