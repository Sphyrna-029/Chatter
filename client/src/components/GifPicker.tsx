import { useState, useEffect, useRef, useCallback } from "react";
import { apiSearchGifs } from "@/lib/api";
import { Loader2, Star } from "lucide-react";
import { useFavoriteGifs } from "@/hooks/useFavoriteGifs";
import { cn } from "@/lib/utils";

interface GifPickerProps {
  onSelect: (gifUrl: string) => void;
}

interface GifItem {
  title?: string;
  file?: {
    xs?: { gif?: { url?: string } };
    sm?: { gif?: { url?: string } };
    md?: { gif?: { url?: string } };
    gif?: { url?: string };
  };
}

const PER_PAGE = 12;

export function GifPicker({ onSelect }: GifPickerProps) {
  const [tab, setTab] = useState<"search" | "favorites">("search");
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState<GifItem[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const { favorites, addFavorite, removeFavorite, isFavorite } = useFavoriteGifs();

  const fetchGifs = useCallback(async (q: string, p: number, append: boolean) => {
    setLoading(true);
    try {
      const resp = await apiSearchGifs(q, p, PER_PAGE);
      const items: GifItem[] = resp?.data?.data || [];
      const hasNext: boolean = resp?.data?.has_next ?? false;
      if (append) {
        setGifs((prev) => [...prev, ...items]);
      } else {
        setGifs(items);
      }
      setHasMore(hasNext);
    } catch {
      if (!append) setGifs([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load trending on mount
  useEffect(() => {
    fetchGifs("", 1, false);
  }, [fetchGifs]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      setHasMore(true);
      fetchGifs(query, 1, false);
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, fetchGifs]);

  const loadMore = () => {
    if (loading || !hasMore) return;
    const nextPage = page + 1;
    setPage(nextPage);
    fetchGifs(query, nextPage, true);
  };

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 50) {
      loadMore();
    }
  };

  const getThumbUrl = (gif: GifItem): string | undefined => {
    return gif.file?.sm?.gif?.url || gif.file?.xs?.gif?.url || gif.file?.gif?.url;
  };

  const getFullUrl = (gif: GifItem): string | undefined => {
    return gif.file?.md?.gif?.url || gif.file?.gif?.url || getThumbUrl(gif);
  };

  return (
    <div className="w-80 flex flex-col">
      {/* Tabs */}
      <div className="flex border-b">
        <button
          className={cn(
            "flex-1 px-3 py-1.5 text-xs font-medium transition-colors",
            tab === "search"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setTab("search")}
        >
          Search
        </button>
        <button
          className={cn(
            "flex-1 px-3 py-1.5 text-xs font-medium transition-colors",
            tab === "favorites"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setTab("favorites")}
        >
          Favorites{favorites.length > 0 && ` (${favorites.length})`}
        </button>
      </div>

      {tab === "search" && (
        <>
          <div className="p-2 border-b">
            <input
              type="text"
              placeholder="Search GIFs..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              autoFocus
            />
          </div>
          <div
            ref={containerRef}
            onScroll={handleScroll}
            className="overflow-y-auto"
            style={{ maxHeight: "420px" }}
          >
            <div className="grid grid-cols-3 gap-1 p-2">
              {gifs.map((gif, i) => {
                const thumb = getThumbUrl(gif);
                const full = getFullUrl(gif);
                if (!thumb || !full) return null;
                const fav = isFavorite(full);
                return (
                  <div key={i} className="relative group">
                    <button
                      className="h-24 w-full overflow-hidden rounded-md border border-border hover:border-primary transition-colors cursor-pointer bg-muted"
                      onClick={() => onSelect(full)}
                      title={gif.title || "GIF"}
                    >
                      <img
                        src={thumb}
                        alt={gif.title || "GIF"}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </button>
                    <button
                      className="absolute top-1 right-1 p-0.5 rounded-sm bg-black/50 can-hover:opacity-0 can-hover:group-hover:opacity-100 transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        fav ? removeFavorite(full) : addFavorite(full);
                      }}
                      title={fav ? "Remove from favorites" : "Add to favorites"}
                    >
                      <Star
                        className={cn(
                          "h-3.5 w-3.5",
                          fav ? "fill-yellow-400 text-yellow-400" : "text-white"
                        )}
                      />
                    </button>
                  </div>
                );
              })}
            </div>
            {loading && (
              <div className="flex justify-center py-3">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {!loading && gifs.length === 0 && (
              <div className="text-center text-xs text-muted-foreground py-8">
                {query ? "No GIFs found" : "No trending GIFs available"}
              </div>
            )}
          </div>
        </>
      )}

      {tab === "favorites" && (
        <div className="overflow-y-auto" style={{ maxHeight: "420px" }}>
          {favorites.length === 0 ? (
            <div className="text-center text-xs text-muted-foreground py-8">
              No favorite GIFs yet. Hover over a GIF and click the star to add it.
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-1 p-2">
              {favorites.map((url) => (
                <div key={url} className="relative group">
                  <button
                    className="h-24 w-full overflow-hidden rounded-md border border-border hover:border-primary transition-colors cursor-pointer bg-muted"
                    onClick={() => onSelect(url)}
                    title="Send GIF"
                  >
                    <img
                      src={url}
                      alt="Favorite GIF"
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  </button>
                  <button
                    className="absolute top-1 right-1 p-0.5 rounded-sm bg-black/50 can-hover:opacity-0 can-hover:group-hover:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFavorite(url);
                    }}
                    title="Remove from favorites"
                  >
                    <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
