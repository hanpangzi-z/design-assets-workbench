import { Op } from 'sequelize';

interface SuperAdminIdentity {
  username?: string | null;
  employeeNo?: string | null;
  authSubject?: string | null;
}

function normalizeIdentifier(value: unknown) {
  return String(value || '').trim();
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function getIdentifierVariants(identifier: string) {
  const normalized = normalizeIdentifier(identifier);
  const withoutWecomPrefix = normalized.replace(/^wecom:/, '');
  return unique([normalized, withoutWecomPrefix, withoutWecomPrefix ? `wecom:${withoutWecomPrefix}` : '']);
}

export function getSuperAdminIdentifiers() {
  return unique(
    [process.env.SUPER_ADMIN_EMPLOYEE_NOS, process.env.SUPER_ADMIN_USERNAMES]
      .filter(Boolean)
      .join(',')
      .split(',')
      .map(normalizeIdentifier),
  );
}

export function getSuperAdminUserWhere(identifier: string) {
  const variants = getIdentifierVariants(identifier);
  return {
    [Op.or]: [
      { username: { [Op.in]: variants } },
      { employeeNo: { [Op.in]: variants } },
      { authSubject: { [Op.in]: variants } },
    ],
  };
}

export function findMatchingSuperAdminIdentifier(user: SuperAdminIdentity, identifiers: string[]) {
  const userValues = new Set(
    unique([
      ...getIdentifierVariants(user.username || ''),
      ...getIdentifierVariants(user.employeeNo || ''),
      ...getIdentifierVariants(user.authSubject || ''),
    ]),
  );

  return identifiers.find((identifier) => getIdentifierVariants(identifier).some((value) => userValues.has(value)));
}
