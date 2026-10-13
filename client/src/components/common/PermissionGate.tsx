import React from 'react';
import useAuthStore from '@/store/authStore';

interface Props {
  permission: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export default function PermissionGate({ permission, children, fallback = null }: Props) {
  const permissions = useAuthStore((s) => s.permissions);
  if (!permissions || !(permissions as unknown as Record<string, boolean>)[permission]) {
    return <>{fallback}</>;
  }
  return <>{children}</>;
}
