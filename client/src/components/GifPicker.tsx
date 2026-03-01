import { useState, useEffect, useRef, useCallback } from "react";
import { apiSearchGifs } from "@/lib/api";
import { Loader2 } from "lucide-react";

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
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState<GifItem[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

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
        style={{ maxHeight: "240px" }}
      >
        <div className="grid grid-cols-3 gap-1 p-2">
          {gifs.map((gif, i) => {
            const thumb = getThumbUrl(gif);
            const full = getFullUrl(gif);
            if (!thumb || !full) return null;
            return (
              <button
                key={i}
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
    </div>
  );
}
