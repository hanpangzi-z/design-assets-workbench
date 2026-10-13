export interface PinSortableLibrary {
  id: number;
  isPinned?: boolean | number | string | null;
  pinnedAt?: string | Date | null;
}

export function isLibraryPinned(value: PinSortableLibrary['isPinned']) {
  return value === true || value === 1 || value === '1';
}

function getPinnedTime(value: PinSortableLibrary['pinnedAt']) {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function sortLibrariesByPin<T extends PinSortableLibrary>(libraries: T[]) {
  return [...libraries].sort((a, b) => {
    const aPinned = isLibraryPinned(a.isPinned);
    const bPinned = isLibraryPinned(b.isPinned);
    if (aPinned !== bPinned) return aPinned ? -1 : 1;

    if (aPinned && bPinned) {
      const pinnedTimeDiff = getPinnedTime(b.pinnedAt) - getPinnedTime(a.pinnedAt);
      if (pinnedTimeDiff !== 0) return pinnedTimeDiff;
    }

    return a.id - b.id;
  });
}
