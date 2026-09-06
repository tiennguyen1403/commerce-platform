"use client";

import { useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ImagePlus,
  Loader2,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import {
  ALLOWED_IMAGE_CONTENT_TYPES,
  IMAGE_ALT_TEXT_MAX,
  MAX_IMAGE_SIZE_BYTES,
  MAX_IMAGES_PER_PRODUCT,
  type ProductImageDto,
} from "@/lib/validators/catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  addProductImageAction,
  deleteProductImageAction,
  getImageUploadUrlAction,
  reorderProductImagesAction,
  updateImageAltTextAction,
} from "./actions";

/**
 * Admin image manager for a **saved** product (edit mode). Each change saves
 * immediately through its own Server Action rather than on the product form's
 * submit, so it is a self-contained widget: the product form's `updateProductAction`
 * never touches images, and these actions never touch the product's other fields.
 *
 * Upload is a three-step, client-orchestrated flow so the bytes never pass through a
 * Server Action (which caps bodies at ~1 MB): the client soft-validates the file and
 * measures its dimensions, calls {@link getImageUploadUrlAction} to mint a direct-PUT
 * target, `PUT`s the raw bytes straight to storage, then calls
 * {@link addProductImageAction} with only the resulting `{ url, key, dims }` metadata.
 *
 * The manager keeps its own authoritative list in React state and updates it from
 * each action's result — no `router.refresh()` — so it stays snappy and never
 * re-seeds from a stale server render mid-session. Reorder is optimistic (revert on
 * failure). Deletes use an inline confirm, never `window.confirm` (a native dialog
 * blocks browser automation and can't be themed).
 */

/** One image as the manager holds it — `altText` is a string ("" for no caption)
 *  so the caption input stays controlled; the wire/DB value stays nullable. */
type ManagedImage = {
  id: string;
  url: string;
  key: string;
  altText: string;
  width: number | null;
  height: number | null;
};

const MAX_IMAGE_SIZE_MB = Math.round(MAX_IMAGE_SIZE_BYTES / (1024 * 1024));
const FILE_ACCEPT = ALLOWED_IMAGE_CONTENT_TYPES.join(",");

function toManaged(image: ProductImageDto): ManagedImage {
  return {
    id: image.id,
    url: image.url,
    key: image.key,
    altText: image.altText ?? "",
    width: image.width,
    height: image.height,
  };
}

/**
 * Read a picture file's intrinsic pixel dimensions in the browser (via `new Image()`)
 * before upload — a remote `next/image` needs `width`/`height` supplied manually, and
 * the client is the only place that has the bytes cheaply. Resolves `null` if the
 * browser can't decode it (or reports non-positive dims), in which case we persist the
 * image without dimensions rather than fail the upload.
 */
function readImageDimensions(
  file: File,
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const { naturalWidth, naturalHeight } = img;
      resolve(
        naturalWidth > 0 && naturalHeight > 0
          ? { width: naturalWidth, height: naturalHeight }
          : null,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(null);
    };
    img.src = objectUrl;
  });
}

export function ProductImageManager({
  storeSlug,
  productId,
  productSlug,
  initialImages,
}: {
  storeSlug: string;
  productId: string;
  /** The product's *persisted* slug — stable identity for storefront revalidation,
   *  independent of the (possibly unsaved) slug field in the product form. */
  productSlug: string;
  initialImages: ProductImageDto[];
}) {
  const [images, setImages] = useState<ManagedImage[]>(() =>
    initialImages.map(toManaged),
  );
  const [error, setError] = useState<string | null>(null);
  // A single in-flight guard: any server round-trip disables every control, so two
  // mutations can't race (e.g. a reorder landing during a delete).
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [altDraft, setAltDraft] = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );

  const fileInputRef = useRef<HTMLInputElement>(null);

  const atCapacity = images.length >= MAX_IMAGES_PER_PRODUCT;

  async function handleFiles(files: File[]) {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const added: ManagedImage[] = [];
      for (const file of files) {
        if (images.length + added.length >= MAX_IMAGES_PER_PRODUCT) {
          setError(
            `A product can have at most ${MAX_IMAGES_PER_PRODUCT} images.`,
          );
          break;
        }
        if (
          !(ALLOWED_IMAGE_CONTENT_TYPES as readonly string[]).includes(
            file.type,
          )
        ) {
          setError(`"${file.name}" isn't a supported image type.`);
          continue;
        }
        if (file.size > MAX_IMAGE_SIZE_BYTES) {
          setError(`"${file.name}" is larger than ${MAX_IMAGE_SIZE_MB} MB.`);
          continue;
        }

        // Wrap the network steps: a `fetch` rejection (offline/DNS) or a rejected
        // action would otherwise throw out of this loop and become an unhandled
        // rejection (the caller invokes handleFiles via `void`). Surface it per file
        // and move on.
        try {
          const dims = await readImageDimensions(file);

          const signed = await getImageUploadUrlAction(storeSlug, productId, {
            contentType: file.type,
            fileName: file.name,
            sizeBytes: file.size,
          });
          if (!signed.ok) {
            setError(signed.error);
            continue;
          }

          // The bytes go straight to storage — never through a Server Action.
          const put = await fetch(signed.uploadUrl, {
            method: "PUT",
            body: file,
            headers: { "content-type": file.type },
          });
          if (!put.ok) {
            setError(`Couldn't upload "${file.name}".`);
            continue;
          }

          const result = await addProductImageAction(
            storeSlug,
            productId,
            productSlug,
            {
              // Echo back exactly what the sign step minted — never an invented URL.
              url: signed.publicUrl,
              key: signed.key,
              altText: undefined,
              width: dims?.width,
              height: dims?.height,
            },
          );
          if (!result.ok) {
            setError(result.error);
            continue;
          }
          added.push(toManaged(result.image));
        } catch {
          setError(`Couldn't upload "${file.name}".`);
        }
      }
      if (added.length) {
        setImages((prev) => [...prev, ...added]);
      }
    } finally {
      setBusy(false);
    }
  }

  function onFileInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files ? Array.from(event.target.files) : [];
    // Reset first, so picking the same file again still fires `change`.
    event.target.value = "";
    if (files.length) void handleFiles(files);
  }

  async function move(index: number, direction: -1 | 1) {
    if (busy) return;
    const target = index + direction;
    if (target < 0 || target >= images.length) return;
    const previous = images;
    const next = [...images];
    [next[index], next[target]] = [next[target], next[index]];
    setImages(next); // optimistic
    setError(null);
    setBusy(true);
    const result = await reorderProductImagesAction(
      storeSlug,
      productId,
      productSlug,
      { orderedIds: next.map((image) => image.id) },
    );
    setBusy(false);
    if (!result.ok) {
      setImages(previous); // revert
      setError(result.error);
    }
  }

  function startEditAlt(image: ManagedImage) {
    setConfirmingDeleteId(null);
    setError(null);
    setEditingId(image.id);
    setAltDraft(image.altText);
  }

  function cancelEditAlt() {
    setEditingId(null);
    setAltDraft("");
  }

  async function saveAlt(id: string) {
    // Reachable via Enter in the caption input even while another op runs, so the
    // "single in-flight" guard is enforced here, not only on the disabled buttons.
    if (busy) return;
    const value = altDraft.trim();
    setBusy(true);
    const result = await updateImageAltTextAction(
      storeSlug,
      productId,
      productSlug,
      { imageId: id, altText: value || undefined },
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setImages((prev) =>
      prev.map((image) =>
        image.id === id ? { ...image, altText: value } : image,
      ),
    );
    cancelEditAlt();
  }

  async function confirmDelete(id: string) {
    if (busy) return;
    setBusy(true);
    const result = await deleteProductImageAction(
      storeSlug,
      productId,
      productSlug,
      id,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setImages((prev) => prev.filter((image) => image.id !== id));
    setConfirmingDeleteId(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Images</CardTitle>
        <CardDescription>
          Upload up to {MAX_IMAGES_PER_PRODUCT} images (JPEG, PNG, or WebP; max{" "}
          {MAX_IMAGE_SIZE_MB} MB each). The first image is the storefront cover
          — use the arrows to reorder.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <p
            role="alert"
            className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm"
          >
            {error}
          </p>
        ) : null}

        {images.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed px-3 py-8 text-center text-sm">
            No images yet. Add one to show it on the storefront.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {images.map((image, index) => {
              const isEditing = editingId === image.id;
              const isConfirmingDelete = confirmingDeleteId === image.id;
              return (
                <li
                  key={image.id}
                  className="border-border flex gap-4 rounded-lg border p-3"
                >
                  {/* Admin-only thumbnail. A plain <img> renders both the local
                      mock's root-relative `/uploads/…` URLs and real `https` Blob
                      URLs with no `next/image` remotePatterns config — that (and
                      storefront optimization) is M5-05/M5-06 scope, not this manager. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.url}
                    alt={image.altText || `Product image ${index + 1}`}
                    className="bg-muted size-20 shrink-0 rounded object-cover"
                  />

                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground text-xs font-medium">
                        Image {index + 1}
                        {index === 0 ? " · Cover" : ""}
                      </span>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => move(index, -1)}
                          disabled={busy || index === 0}
                          aria-label={`Move image ${index + 1} up`}
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => move(index, 1)}
                          disabled={busy || index === images.length - 1}
                          aria-label={`Move image ${index + 1} down`}
                        >
                          <ArrowDown />
                        </Button>
                      </div>
                    </div>

                    {isEditing ? (
                      <div className="flex flex-col gap-2">
                        <Input
                          value={altDraft}
                          onChange={(e) => setAltDraft(e.target.value)}
                          // The manager lives inside the product <form>: Enter would
                          // submit it, so save the caption instead; Escape cancels.
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void saveAlt(image.id);
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              cancelEditAlt();
                            }
                          }}
                          maxLength={IMAGE_ALT_TEXT_MAX}
                          placeholder="Describe this image"
                          aria-label={`Caption for image ${index + 1}`}
                          disabled={busy}
                          autoFocus
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => saveAlt(image.id)}
                            disabled={busy}
                          >
                            {busy ? (
                              <Loader2 className="animate-spin" />
                            ) : (
                              <Check />
                            )}
                            Save
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={cancelEditAlt}
                            disabled={busy}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm">
                        {image.altText ? (
                          image.altText
                        ) : (
                          <span className="text-muted-foreground italic">
                            No caption
                          </span>
                        )}
                      </p>
                    )}

                    {!isEditing ? (
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => startEditAlt(image)}
                          disabled={busy}
                        >
                          <Pencil />
                          {image.altText ? "Edit caption" : "Add caption"}
                        </Button>
                        {isConfirmingDelete ? (
                          <div className="flex items-center gap-1">
                            <span className="text-muted-foreground text-sm">
                              Delete?
                            </span>
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              onClick={() => confirmDelete(image.id)}
                              disabled={busy}
                              aria-label={`Confirm delete image ${index + 1}`}
                            >
                              {busy ? (
                                <Loader2 className="animate-spin" />
                              ) : (
                                <Check />
                              )}
                              Delete
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirmingDeleteId(null)}
                              disabled={busy}
                              aria-label={`Cancel delete image ${index + 1}`}
                            >
                              <X />
                            </Button>
                          </div>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => {
                              setEditingId(null);
                              setConfirmingDeleteId(image.id);
                            }}
                            disabled={busy}
                          >
                            <Trash2 />
                            Delete
                          </Button>
                        )}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept={FILE_ACCEPT}
            multiple
            hidden
            onChange={onFileInputChange}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || atCapacity}
            className="w-fit"
          >
            {busy ? <Loader2 className="animate-spin" /> : <ImagePlus />}
            Add images
          </Button>
          <span className="text-muted-foreground text-xs">
            {images.length} / {MAX_IMAGES_PER_PRODUCT}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
