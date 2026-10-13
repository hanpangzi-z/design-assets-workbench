import { create } from 'zustand';
import type { Category } from 'shared/types';
import { getCategoryTree, createCategory, updateCategory, deleteCategory } from '@/api/categories';

interface CategoryState {
  folders: Category[];
  dimensionCategories: Record<string, Category[]>;
  allCategories: Category[];
  isLoading: boolean;
  activeLibraryId?: number;

  fetchAll: (libraryId?: number) => Promise<void>;
  fetchByDimension: (dimension: string, libraryId?: number) => Promise<void>;
  addCategory: (data: { name: string; parentId?: number | null; dimension?: string; sortOrder?: number; libraryId?: number }) => Promise<Category>;
  editCategory: (id: number, data: Partial<{ name: string; parentId: number | null }>) => Promise<void>;
  removeCategory: (id: number) => Promise<void>;
}

const useCategoryStore = create<CategoryState>((set, get) => ({
  folders: [],
  dimensionCategories: {},
  allCategories: [],
  isLoading: false,
  activeLibraryId: undefined,

  fetchAll: async (libraryId) => {
    set({ isLoading: true, activeLibraryId: libraryId });
    try {
      const tree = await getCategoryTree({ libraryId });
      const folders: Category[] = [];
      const dimMap: Record<string, Category[]> = {};

      function flatten(cats: Category[]) {
        for (const c of cats) {
          if (c.dimension) {
            // 只收顶级分类（parentId 为空），子分类保留在其 children 里用于三级展示
            if (c.parentId == null) {
              const key = String(c.dimension);
              if (!dimMap[key]) dimMap[key] = [];
              dimMap[key].push(c);
            }
          } else {
            folders.push(c);
          }
          if (c.children?.length) flatten(c.children);
        }
      }
      flatten(tree);

      set({ folders, dimensionCategories: dimMap, allCategories: tree, isLoading: false });
    } catch {
      set({ isLoading: false, folders: [], dimensionCategories: {}, allCategories: [] });
    }
  },

  fetchByDimension: async (dimension, libraryId) => {
    try {
      const cats = await getCategoryTree({ dimension, libraryId: libraryId ?? get().activeLibraryId });
      set((state) => ({
        dimensionCategories: { ...state.dimensionCategories, [dimension]: cats },
      }));
    } catch {
      // ignore
    }
  },

  addCategory: async (data) => {
    const cat = await createCategory(data);
    await get().fetchAll(data.libraryId ?? get().activeLibraryId);
    return cat;
  },

  editCategory: async (id, data) => {
    await updateCategory(id, data);
    await get().fetchAll(get().activeLibraryId);
  },

  removeCategory: async (id) => {
    await deleteCategory(id);
    await get().fetchAll(get().activeLibraryId);
  },
}));

export default useCategoryStore;
