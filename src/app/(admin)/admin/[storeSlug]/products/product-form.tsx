"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Plus, Trash2 } from "lucide-react";
import {
  CURRENCY_LABELS,
  PRODUCT_STATUSES,
  STATUS_LABELS,
  productInputSchema,
  type ActionResult,
  type CurrencyValue,
  type ProductStatusValue,
} from "@/lib/validators/catalog";
import { slugify } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createProductAction, updateProductAction } from "./actions";

/** A single variant row as the form holds it — money/stock kept as raw strings
 *  so the inputs stay controlled; converted to integers only on submit. */
type VariantRow = {
  key: string;
  id?: string;
  sku: string;
  name: string;
  price: string;
  stock: string;
  // True when this variant already appears in an order. Such variants can't be
  // deleted (the server refuses it), so the row's Remove button is disabled.
  hasOrders?: boolean;
};

export type ProductFormInitialVariant = {
  id?: string;
  sku: string;
  name: string;
  price: string;
  stock: string;
  hasOrders?: boolean;
};

export type ProductFormValues = {
  title: string;
  slug: string;
  description: string;
  status: ProductStatusValue;
  variants: ProductFormInitialVariant[];
};

type ProductFormProps = {
  mode: "create" | "edit";
  /** The active store's slug — scopes the action calls and post-save redirect. */
  storeSlug: string;
  productId?: string;
  initialValues: ProductFormValues;
  /** The store's currency (`Tenant.currency`); every variant price is in it. */
  storeCurrency: string;
};

type VariantFieldErrors = Partial<
  Record<"sku" | "name" | "price" | "stock", string>
>;

const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;
const WHOLE_PATTERN = /^\d+$/;

/** Dollars string → integer cents, or null if malformed. */
function parseMoneyToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!MONEY_PATTERN.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100);
}

/** Whole-number string → integer, or null if malformed. */
function parseWhole(value: string): number | null {
  const trimmed = value.trim();
  if (!WHOLE_PATTERN.test(trimmed)) return null;
  return Number(trimmed);
}

function emptyVariant(key: string): VariantRow {
  return { key, sku: "", name: "", price: "", stock: "0" };
}

export function ProductForm({
  mode,
  storeSlug,
  productId,
  initialValues,
  storeCurrency,
}: ProductFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // The store's single currency, shown read-only — variants have no currency of
  // their own (they inherit `Tenant.currency`). Fall back to the raw code if it
  // isn't one we have a friendly label for.
  const currencyLabel =
    CURRENCY_LABELS[storeCurrency as CurrencyValue] ??
    storeCurrency.toUpperCase();

  const [title, setTitle] = useState(initialValues.title);
  const [slug, setSlug] = useState(initialValues.slug);
  const [description, setDescription] = useState(initialValues.description);
  const [status, setStatus] = useState<ProductStatusValue>(
    initialValues.status,
  );
  const [variants, setVariants] = useState<VariantRow[]>(() =>
    initialValues.variants.map((v, index) => ({
      ...v,
      key: v.id ?? `row-${index}`,
    })),
  );
  // Once the admin edits the slug by hand, stop auto-deriving it from the title.
  const [slugEdited, setSlugEdited] = useState(mode === "edit");

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [variantErrors, setVariantErrors] = useState<
    Record<string, VariantFieldErrors>
  >({});

  const nextKey = useRef(initialValues.variants.length);

  function onTitleChange(value: string) {
    setTitle(value);
    if (!slugEdited) setSlug(slugify(value));
  }

  function updateVariant(key: string, patch: Partial<VariantRow>) {
    setVariants((rows) =>
      rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  }

  function addVariant() {
    setVariants((rows) => [...rows, emptyVariant(`new-${nextKey.current++}`)]);
  }

  function removeVariant(key: string) {
    setVariants((rows) => rows.filter((row) => row.key !== key));
    setVariantErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const topErrors: Record<string, string> = {};
    const rowErrors: Record<string, VariantFieldErrors> = {};

    const builtVariants = variants.map((row) => {
      const cents = parseMoneyToCents(row.price);
      const stock = parseWhole(row.stock);
      const rowError: VariantFieldErrors = {};
      if (cents === null) rowError.price = "Enter a price like 19.99.";
      if (stock === null) rowError.stock = "Enter a whole number.";
      if (Object.keys(rowError).length) rowErrors[row.key] = rowError;
      return {
        id: row.id,
        sku: row.sku,
        name: row.name,
        priceCents: cents ?? 0,
        stock: stock ?? 0,
      };
    });

    const parsed = productInputSchema.safeParse({
      title,
      slug,
      description: description.trim() || undefined,
      status,
      variants: builtVariants,
    });

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const [p0, p1, p2] = issue.path;
        if (p0 === "variants" && typeof p1 === "number") {
          const key = variants[p1]?.key;
          if (!key) continue;
          const field = (p2 === "priceCents" ? "price" : p2) as
            keyof VariantFieldErrors | undefined;
          if (field) {
            rowErrors[key] = {
              [field]: issue.message,
              ...rowErrors[key],
            };
          }
        } else if (p0 === "variants") {
          topErrors.variants ??= issue.message;
        } else if (typeof p0 === "string") {
          topErrors[p0] ??= issue.message;
        }
      }
    }

    if (!parsed.success || Object.keys(rowErrors).length) {
      setErrors(topErrors);
      setVariantErrors(rowErrors);
      return;
    }

    setErrors({});
    setVariantErrors({});

    startTransition(async () => {
      const result: ActionResult =
        mode === "edit" && productId
          ? await updateProductAction(storeSlug, productId, parsed.data)
          : await createProductAction(storeSlug, parsed.data);

      if (result.ok) {
        router.push(`/admin/${storeSlug}/products`);
        router.refresh();
        return;
      }

      const serverErrors: Record<string, string> = {};
      if (result.formError) serverErrors.form = result.formError;
      if (result.fieldErrors) Object.assign(serverErrors, result.fieldErrors);
      setErrors(serverErrors);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6" noValidate>
      {errors.form ? (
        <p
          role="alert"
          className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm"
        >
          {errors.form}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Product details</CardTitle>
          <CardDescription>
            A draft stays hidden; set the status to Active to show it on the
            storefront.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="title">Title</FieldLabel>
            <Input
              id="title"
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              aria-invalid={Boolean(errors.title)}
              placeholder="Classic Tee"
              autoComplete="off"
            />
            <FieldError
              errors={errors.title ? [{ message: errors.title }] : undefined}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="slug">Slug</FieldLabel>
            <Input
              id="slug"
              value={slug}
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(e.target.value);
              }}
              aria-invalid={Boolean(errors.slug)}
              placeholder="classic-tee"
              autoComplete="off"
            />
            <FieldError
              errors={errors.slug ? [{ message: errors.slug }] : undefined}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="description">Description</FieldLabel>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="Optional. Shown on the product page."
              aria-invalid={Boolean(errors.description)}
            />
            <FieldError
              errors={
                errors.description
                  ? [{ message: errors.description }]
                  : undefined
              }
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="status">Status</FieldLabel>
            <Select
              value={status}
              onValueChange={(value) => {
                if (value) setStatus(value);
              }}
            >
              <SelectTrigger id="status" className="w-full">
                <SelectValue>
                  {(value) => STATUS_LABELS[value as ProductStatusValue]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PRODUCT_STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {STATUS_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Variants</CardTitle>
          <CardDescription>
            Each variant needs a unique SKU. Prices are per item, in{" "}
            {currencyLabel} — the store currency.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {errors.variants ? (
            <p role="alert" className="text-destructive text-sm">
              {errors.variants}
            </p>
          ) : null}

          {variants.map((row, index) => {
            const rowError = variantErrors[row.key] ?? {};
            return (
              <div
                key={row.key}
                className="border-border flex flex-col gap-4 rounded-lg border p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground text-sm font-medium">
                    Variant {index + 1}
                  </span>
                  <div className="flex items-center gap-2">
                    {row.hasOrders ? (
                      <span className="text-muted-foreground text-xs">
                        Has orders
                      </span>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeVariant(row.key)}
                      disabled={variants.length === 1 || Boolean(row.hasOrders)}
                      // Encode the disabled reason in the accessible name: a
                      // disabled button is out of tab order, but its name is
                      // still exposed to screen readers browsing the form.
                      aria-label={
                        row.hasOrders
                          ? `Remove variant ${index + 1} — unavailable, this variant has orders`
                          : `Remove variant ${index + 1}`
                      }
                      title={
                        row.hasOrders
                          ? "This variant has orders and can't be removed."
                          : undefined
                      }
                    >
                      <Trash2 />
                      Remove
                    </Button>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor={`${row.key}-sku`}>SKU</FieldLabel>
                    <Input
                      id={`${row.key}-sku`}
                      value={row.sku}
                      onChange={(e) =>
                        updateVariant(row.key, { sku: e.target.value })
                      }
                      aria-invalid={Boolean(rowError.sku)}
                      placeholder="TEE-M"
                      autoComplete="off"
                    />
                    <FieldError
                      errors={
                        rowError.sku ? [{ message: rowError.sku }] : undefined
                      }
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor={`${row.key}-name`}>Name</FieldLabel>
                    <Input
                      id={`${row.key}-name`}
                      value={row.name}
                      onChange={(e) =>
                        updateVariant(row.key, { name: e.target.value })
                      }
                      aria-invalid={Boolean(rowError.name)}
                      placeholder="Medium"
                      autoComplete="off"
                    />
                    <FieldError
                      errors={
                        rowError.name ? [{ message: rowError.name }] : undefined
                      }
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor={`${row.key}-price`}>Price</FieldLabel>
                    <Input
                      id={`${row.key}-price`}
                      value={row.price}
                      inputMode="decimal"
                      onChange={(e) =>
                        updateVariant(row.key, { price: e.target.value })
                      }
                      aria-invalid={Boolean(rowError.price)}
                      placeholder="19.99"
                      autoComplete="off"
                    />
                    <FieldError
                      errors={
                        rowError.price
                          ? [{ message: rowError.price }]
                          : undefined
                      }
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor={`${row.key}-stock`}>Stock</FieldLabel>
                    <Input
                      id={`${row.key}-stock`}
                      value={row.stock}
                      inputMode="numeric"
                      onChange={(e) =>
                        updateVariant(row.key, { stock: e.target.value })
                      }
                      aria-invalid={Boolean(rowError.stock)}
                      placeholder="0"
                      autoComplete="off"
                    />
                    <FieldError
                      errors={
                        rowError.stock
                          ? [{ message: rowError.stock }]
                          : undefined
                      }
                    />
                  </Field>
                </div>
              </div>
            );
          })}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addVariant}
            className="w-fit"
          >
            <Plus />
            Add variant
          </Button>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : null}
          {mode === "edit" ? "Save changes" : "Create product"}
        </Button>
        <Button
          variant="ghost"
          nativeButton={false}
          render={<Link href={`/admin/${storeSlug}/products`} />}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
