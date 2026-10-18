import { libraryGet } from './api.js';
import { normaliseItem, type LibraryItem } from './library-item.js';

export async function readLibrary(authKey: string): Promise<LibraryItem[]> {
  return (await libraryGet(authKey))
    .filter((item) => item?._id && item.state)
    .map(normaliseItem);
}
