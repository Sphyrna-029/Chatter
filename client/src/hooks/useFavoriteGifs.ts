import { useState, useCallback } from "react";

const STORAGE_KEY = "chatter_favorite_gifs";

function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function useFavoriteGifs() {
  const [favorites, setFavorites] = useState<string[]>(loadFavorites);

  const addFavorite = useCallback((url: string) => {
    setFavorites((prev) => {
      if (prev.includes(url)) return prev;
      const next = [url, ...prev];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const removeFavorite = useCallback((url: string) => {
    setFavorites((prev) => {
      const next = prev.filter((u) => u !== url);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const isFavorite = useCallback((url: string) => {
    return favorites.includes(url);
  }, [favorites]);

  return { favorites, addFavorite, removeFavorite, isFavorite };
}
