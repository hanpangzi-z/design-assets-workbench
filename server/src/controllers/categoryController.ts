import { Request, Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import { Category, DesignFile, FileTag, FileCategory, Tag } from '../models';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth';

function toPositiveInt(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function scopedWhere(libraryId: number | null): Record<string, unknown> {
  return { libraryId: libraryId ?? null };
}

function buildTree(
  categories: Category[],
  fileCounts: Map<number, number>,
  branchFileCounts: Map<number, number>,
  parentId: number | null = null,
): unknown[] {
  return categories
    .filter((category) => category.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((category) => ({
      ...category.toJSON(),
      fileCount: fileCounts.get(category.id) || 0,
      branchFileCount: branchFileCounts.get(category.id) || fileCounts.get(category.id) || 0,
      children: buildTree(categories, fileCounts, branchFileCounts, category.id),
    }));
}

async function getFileCounts(libraryId: number | null, categories: Category[], includePersonal = false) {
  const counts = new Map<number, number>();
  const fileIdsByCategory = new Map<number, Set<number>>();
  const categoryIds = categories.map((category) => category.id);
  if (categoryIds.length === 0) return { fileCounts: counts, branchFileCounts: new Map<number, number>() };
  const visibleFileWhere = {
    isDeleted: false,
    libraryId: libraryId ?? null,
    ...(includePersonal ? {} : { isPersonalCopy: false }),
  };

  const addFile = (categoryId: number, fileId: number) => {
    if (!fileIdsByCategory.has(categoryId)) fileIdsByCategory.set(categoryId, new Set<number>());
    fileIdsByCategory.get(categoryId)!.add(fileId);
  };

  const directRows = await DesignFile.findAll({
    attributes: ['id', 'categoryId'],
    where: {
      ...visibleFileWhere,
      categoryId: { [Op.in]: categoryIds },
    },
    raw: true,
  }) as unknown as Array<{ id: number; categoryId: number | null }>;

  for (const row of directRows) {
    if (!row.categoryId) continue;
    addFile(row.categoryId, row.id);
  }

  const assignmentRows = await FileCategory.findAll({
    attributes: ['fileId', 'categoryId'],
    where: { categoryId: { [Op.in]: categoryIds } },
    raw: true,
  }) as unknown as Array<{ fileId: number; categoryId: number }>;

  const assignmentFileIds = Array.from(new Set(
    assignmentRows
      .map((row) => Number(row.fileId))
      .filter((id) => Number.isInteger(id) && id > 0),
  ));
  if (assignmentFileIds.length > 0) {
    const validFiles = await DesignFile.findAll({
      attributes: ['id'],
      where: {
        ...visibleFileWhere,
        id: { [Op.in]: assignmentFileIds },
      },
      raw: true,
    }) as unknown as Array<{ id: number }>;
    const validFileIds = new Set(validFiles.map((file) => Number(file.id)));
    for (const row of assignmentRows) {
      if (!validFileIds.has(Number(row.fileId))) continue;
      addFile(Number(row.categoryId), Number(row.fileId));
    }
  }

  const legacyCounts = await getLegacyCategoryTagFileIds(libraryId, categories, includePersonal);
  legacyCounts.forEach((fileIds, categoryId) => {
    fileIds.forEach((fileId) => addFile(categoryId, fileId));
  });

  fileIdsByCategory.forEach((fileIds, categoryId) => counts.set(categoryId, fileIds.size));

  const childrenByParent = new Map<number | null, Category[]>();
  categories.forEach((category) => {
    const parentId = category.parentId ?? null;
    childrenByParent.set(parentId, [...(childrenByParent.get(parentId) || []), category]);
  });

  const branchSets = new Map<number, Set<number>>();
  const getBranchSet = (categoryId: number): Set<number> => {
    const cached = branchSets.get(categoryId);
    if (cached) return cached;

    const fileIds = new Set(fileIdsByCategory.get(categoryId) || []);
    for (const child of childrenByParent.get(categoryId) || []) {
      getBranchSet(child.id).forEach((fileId) => fileIds.add(fileId));
    }
    branchSets.set(categoryId, fileIds);
    return fileIds;
  };

  const branchCounts = new Map<number, number>();
  categories.forEach((category) => branchCounts.set(category.id, getBranchSet(category.id).size));

  return { fileCounts: counts, branchFileCounts: branchCounts };
}

async function getLegacyCategoryTagFileIds(libraryId: number | null, categories: Category[], includePersonal = false) {
  const tagNames = Array.from(new Set(categories.map((category) => category.name).filter(Boolean)));
  if (tagNames.length === 0) return new Map<number, Set<number>>();

  const sameNameCategories = await Category.findAll({
    where: {
      name: { [Op.in]: tagNames },
      dimension: { [Op.ne]: null },
      libraryId: libraryId ?? null,
    },
    attributes: ['id', 'name'],
    raw: true,
  }) as unknown as Array<{ id: number; name: string }>;
  const sameNameCategoryIdsByName = new Map<string, Set<number>>();
  sameNameCategories.forEach((category) => {
    if (!sameNameCategoryIdsByName.has(category.name)) sameNameCategoryIdsByName.set(category.name, new Set<number>());
    sameNameCategoryIdsByName.get(category.name)!.add(Number(category.id));
  });
  const sameNameCategoryIds = Array.from(new Set(sameNameCategories.map((category) => Number(category.id))));

  const tags = await Tag.findAll({
    where: { name: { [Op.in]: tagNames } },
    attributes: ['id', 'name'],
    raw: true,
  }) as unknown as Array<{ id: number; name: string }>;
  if (tags.length === 0) return new Map<number, Set<number>>();

  const tagNameById = new Map(tags.map((tag) => [Number(tag.id), tag.name]));
  const fileTags = await FileTag.findAll({
    where: { tagId: { [Op.in]: tags.map((tag) => tag.id) } },
    attributes: ['fileId', 'tagId'],
    raw: true,
  }) as unknown as Array<{ fileId: number; tagId: number }>;
  const taggedFileIds = Array.from(new Set(
    fileTags
      .map((row) => Number(row.fileId))
      .filter((id) => Number.isInteger(id) && id > 0),
  ));
  if (taggedFileIds.length === 0) return new Map<number, Set<number>>();

  const validFiles = await DesignFile.findAll({
    attributes: ['id', 'categoryId'],
    where: {
      id: { [Op.in]: taggedFileIds },
      isDeleted: false,
      libraryId: libraryId ?? null,
      ...(includePersonal ? {} : { isPersonalCopy: false }),
    },
    raw: true,
  }) as unknown as Array<{ id: number; categoryId: number | null }>;
  const validFileIds = new Set(validFiles.map((file) => Number(file.id)));
  if (validFileIds.size === 0) return new Map<number, Set<number>>();

  const structuredCategoryIdsByFileId = new Map<number, Set<number>>();
  validFiles.forEach((file) => {
    const categoryId = Number(file.categoryId);
    if (!Number.isInteger(categoryId) || categoryId <= 0) return;
    structuredCategoryIdsByFileId.set(Number(file.id), new Set([categoryId]));
  });

  if (sameNameCategoryIds.length > 0) {
    const categoryRows = await FileCategory.findAll({
      attributes: ['fileId', 'categoryId'],
      where: {
        fileId: { [Op.in]: Array.from(validFileIds) },
        categoryId: { [Op.in]: sameNameCategoryIds },
      },
      raw: true,
    }) as unknown as Array<{ fileId: number; categoryId: number }>;
    categoryRows.forEach((row) => {
      const fileId = Number(row.fileId);
      const categoryId = Number(row.categoryId);
      if (!structuredCategoryIdsByFileId.has(fileId)) structuredCategoryIdsByFileId.set(fileId, new Set<number>());
      structuredCategoryIdsByFileId.get(fileId)!.add(categoryId);
    });
  }

  const namesByFileId = new Map<number, Set<string>>();
  for (const row of fileTags) {
    if (!validFileIds.has(Number(row.fileId))) continue;
    const name = tagNameById.get(Number(row.tagId));
    if (!name) continue;
    const fileId = Number(row.fileId);
    if (!namesByFileId.has(fileId)) namesByFileId.set(fileId, new Set<string>());
    namesByFileId.get(fileId)!.add(name);
  }

  const fileIdsByCategory = new Map<number, Set<number>>();
  const add = (categoryId: number, fileId: number) => {
    if (!fileIdsByCategory.has(categoryId)) fileIdsByCategory.set(categoryId, new Set<number>());
    fileIdsByCategory.get(categoryId)!.add(fileId);
  };

  for (const category of categories) {
    namesByFileId.forEach((names, fileId) => {
      if (!names.has(category.name)) return;
      const sameNameIds = sameNameCategoryIdsByName.get(category.name) || new Set<number>();
      const structuredIds = structuredCategoryIdsByFileId.get(fileId) || new Set<number>();
      const hasOtherSameNameCategory = Array.from(structuredIds).some((id) => sameNameIds.has(id) && id !== category.id);
      if (hasOtherSameNameCategory) return;
      add(category.id, fileId);
    });
  }

  return fileIdsByCategory;
}

export async function getTree(req: Request, res: Response, next: NextFunction) {
  try {
    const { dimension } = req.query;
    const libraryId = toPositiveInt(req.query.libraryId);
    const includePersonal = req.query.includePersonal === 'true';
    const where: Record<string, unknown> = {
      ...scopedWhere(libraryId),
      dimension: { [Op.ne]: null },
    };

    if (dimension) where.dimension = String(dimension);

    const categories = await Category.findAll({
      where,
      order: [['sort_order', 'ASC'], ['id', 'ASC']],
    });
    const { fileCounts, branchFileCounts } = await getFileCounts(libraryId, categories as Category[], includePersonal);

    res.json({
      code: 200,
      message: 'OK',
      data: buildTree(categories as Category[], fileCounts, branchFileCounts),
    });
  } catch (err) {
    next(err);
  }
}

export async function getById(req: Request, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const category = await Category.findByPk(id);
    if (!category) throw new AppError('Category not found', 404);

    const children = await Category.findAll({
      where: { parentId: category.id, libraryId: category.libraryId },
      order: [['sort_order', 'ASC'], ['id', 'ASC']],
    });

    res.json({
      code: 200,
      message: 'OK',
      data: { ...category.toJSON(), children },
    });
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { name, parentId, description, icon, dimension, sortOrder } = req.body;
    const trimmedName = String(name || '').trim();
    if (!trimmedName) throw new AppError('Category name is required', 400);

    const parsedParentId = toPositiveInt(parentId);
    let libraryId = toPositiveInt(req.body.libraryId);
    let normalizedParentId: number | null = null;

    if (parsedParentId) {
      const parent = await Category.findByPk(parsedParentId);
      if (!parent) throw new AppError('Parent category not found', 400);
      if (libraryId && parent.libraryId !== libraryId) {
        throw new AppError('Parent category belongs to another library', 400);
      }
      libraryId = parent.libraryId;
      normalizedParentId = parent.id;
    }

    if (!libraryId) throw new AppError('libraryId is required', 400);

    const normalizedDimension = dimension === undefined || dimension === null
      ? null
      : String(dimension).trim();

    const existing = await Category.findOne({
      where: {
        name: trimmedName,
        parentId: normalizedParentId,
        dimension: normalizedDimension,
        libraryId,
      },
    });
    if (existing) throw new AppError('Category already exists in this library', 409);

    const category = await Category.create({
      name: trimmedName,
      parentId: normalizedParentId,
      description,
      icon,
      dimension: normalizedDimension,
      libraryId,
      sortOrder: sortOrder || 0,
      createdBy: req.user?.id || null,
    });

    res.status(201).json({
      code: 201,
      message: 'Created',
      data: category,
    });
  } catch (err) {
    next(err);
  }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const category = await Category.findByPk(id);
    if (!category) throw new AppError('Category not found', 404);

    const { name, parentId, description, icon, dimension, sortOrder } = req.body;
    const updateData: Record<string, unknown> = {};

    if (name !== undefined) {
      const trimmedName = String(name).trim();
      if (!trimmedName) throw new AppError('Category name is required', 400);
      updateData.name = trimmedName;
    }

    if (parentId !== undefined) {
      const nextParentId = toPositiveInt(parentId);
      if (nextParentId === category.id) {
        throw new AppError('Category cannot be its own parent', 400);
      }
      if (nextParentId) {
        const parent = await Category.findByPk(nextParentId);
        if (!parent) throw new AppError('Parent category not found', 400);
        if (parent.libraryId !== category.libraryId) {
          throw new AppError('Parent category belongs to another library', 400);
        }
      }
      updateData.parentId = nextParentId;
    }

    if (description !== undefined) updateData.description = description;
    if (icon !== undefined) updateData.icon = icon;
    if (dimension !== undefined) updateData.dimension = dimension === null ? null : String(dimension).trim();
    if (sortOrder !== undefined) updateData.sortOrder = sortOrder;

    await category.update(updateData);

    res.json({
      code: 200,
      message: 'Updated',
      data: category,
    });
  } catch (err) {
    next(err);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const category = await Category.findByPk(id);
    if (!category) throw new AppError('Category not found', 404);
    const libraryId = category.libraryId;

    const categoriesToDelete: Category[] = [];
    async function collectRecursive(cat: Category) {
      categoriesToDelete.push(cat);
      const children = await Category.findAll({
        where: { parentId: cat.id, libraryId },
      });
      for (const child of children) {
        await collectRecursive(child);
      }
    }

    await collectRecursive(category);
    const deleteIds = categoriesToDelete.map((cat) => cat.id);
    const deleteNames = Array.from(new Set(categoriesToDelete.map((cat) => cat.name).filter(Boolean)));

    if (deleteNames.length > 0) {
      const remainingCategories = await Category.findAll({
        where: {
          id: { [Op.notIn]: deleteIds },
          name: { [Op.in]: deleteNames },
          dimension: { [Op.ne]: null },
          libraryId: libraryId ?? null,
        },
        attributes: ['name'],
        raw: true,
      }) as unknown as Array<{ name: string }>;
      const remainingNames = new Set(remainingCategories.map((cat) => cat.name));
      const namesToClear = deleteNames.filter((name) => !remainingNames.has(name));
      if (namesToClear.length > 0) {
        const tags = await Tag.findAll({
          where: { name: { [Op.in]: namesToClear } },
          attributes: ['id'],
          raw: true,
        }) as unknown as Array<{ id: number }>;
        const tagIds = tags.map((tag) => tag.id);
        if (tagIds.length > 0) {
          const files = await DesignFile.findAll({
            attributes: ['id'],
            where: { libraryId: libraryId ?? null },
            raw: true,
          }) as unknown as Array<{ id: number }>;
          const fileIds = files.map((file) => file.id);
          if (fileIds.length > 0) {
            await FileTag.destroy({ where: { fileId: { [Op.in]: fileIds }, tagId: { [Op.in]: tagIds } } });
          }
        }
      }
    }

    await FileCategory.destroy({ where: { categoryId: { [Op.in]: deleteIds } } });
    await DesignFile.update({ categoryId: null }, { where: { categoryId: { [Op.in]: deleteIds } } });
    for (const cat of categoriesToDelete.slice().reverse()) {
      await Category.destroy({ where: { id: cat.id } });
    }

    res.json({
      code: 200,
      message: 'Deleted',
      data: null,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateSort(req: Request, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const { sortOrder } = req.body;

    const category = await Category.findByPk(id);
    if (!category) throw new AppError('Category not found', 404);

    await category.update({ sortOrder });

    res.json({
      code: 200,
      message: 'Updated',
      data: category,
    });
  } catch (err) {
    next(err);
  }
}

export async function batchUpdateSort(req: Request, res: Response, next: NextFunction) {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) throw new AppError('Invalid items', 400);

    for (const item of items) {
      const category = await Category.findByPk(item.id);
      if (!category) continue;

      const updateData: Record<string, unknown> = { sortOrder: item.sortOrder };
      if (item.parentId !== undefined) {
        const nextParentId = toPositiveInt(item.parentId);
        if (nextParentId) {
          const parent = await Category.findByPk(nextParentId);
          if (!parent || parent.libraryId !== category.libraryId) continue;
        }
        updateData.parentId = nextParentId;
      }
      await category.update(updateData);
    }

    res.json({
      code: 200,
      message: 'Updated',
      data: null,
    });
  } catch (err) {
    next(err);
  }
}
