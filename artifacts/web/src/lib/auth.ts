import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export interface Me {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  orgId: number;
  orgName: string;
  role: string;
}
export interface OrgInfo {
  orgId: number;
  orgName: string;
  role: string;
}

export function useAuthUser() {
  const q = useQuery({
    queryKey: ["auth"],
    queryFn: () =>
      api<{
        user: Me | null;
        signedIn: boolean;
        restricted: boolean;
        email: string | null;
        setupRequired: boolean;
        setupTokenRequired?: boolean;
        orgs?: OrgInfo[];
        activeOrgId?: number | null;
      }>("/auth/user"),
    staleTime: 60_000,
  });
  return {
    ...q,
    user: q.data?.user ?? null,
    orgs: q.data?.orgs ?? [],
    logout: () => (window.location.href = "/api/logout?returnTo=/"),
  };
}
