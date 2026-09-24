export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface HotelInfo {
  id: string;
  name: string;
  slug?: string | null;
}

export function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

export function getAuthUser(): AuthUser | null {
  const user = localStorage.getItem("hotel_user");
  return user ? JSON.parse(user) : null;
}

export function getHotelInfo(): HotelInfo | null {
  const hotel = localStorage.getItem("hotel_info");
  return hotel ? JSON.parse(hotel) : null;
}

export function isAuthenticated(): boolean {
  return !!getAuthToken();
}

export function logout(): void {
  const token = getAuthToken();
  if (token) {
    fetch("/api/auth/logout", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
      },
    }).catch(console.error);
  }
  localStorage.removeItem("auth_token");
  localStorage.removeItem("hotel_user");
  localStorage.removeItem("hotel_info");
}

export function getAuthHeaders(): HeadersInit {
  const token = getAuthToken();
  if (!token) return {};
  return {
    "Authorization": `Bearer ${token}`,
  };
}
