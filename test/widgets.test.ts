import { describe, expect, it } from "vitest";
import { NAME_MAX_LENGTH, WidgetStore, validateWidgetInput } from "../src/widgets.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("validateWidgetInput — accepted input", () => {
    it("accepts a name and an integer quantity", () => {
        expect(validateWidgetInput({ name: "gear", quantity: 3 })).toEqual({ ok: true, value: { name: "gear", quantity: 3 } });
    });

    it("accepts the boundaries: a 1-character name, a 64-character name and quantity 0", () => {
        expect(validateWidgetInput({ name: "x", quantity: 0 }).ok).toBe(true);
        expect(validateWidgetInput({ name: "x".repeat(NAME_MAX_LENGTH), quantity: 0 }).ok).toBe(true);
        expect(NAME_MAX_LENGTH).toBe(64);
    });

    it("trims the name, and measures its length after trimming", () => {
        expect(validateWidgetInput({ name: "  spaced out \n", quantity: 1 })).toEqual({
            ok: true,
            value: { name: "spaced out", quantity: 1 },
        });
        const padded = validateWidgetInput({ name: `  ${"x".repeat(64)}  `, quantity: 1 });
        expect(padded).toEqual({ ok: true, value: { name: "x".repeat(64), quantity: 1 } });
    });

    it("returns only name and quantity — anything else the client sent is ignored, not an error", () => {
        const result = validateWidgetInput({ id: "client", createdAt: "1999-01-01T00:00:00.000Z", name: "gear", quantity: 1, extra: true });
        expect(result).toEqual({ ok: true, value: { name: "gear", quantity: 1 } });
    });
});

describe("validateWidgetInput — rejected input always explains itself", () => {
    const rejected: Array<[label: string, payload: unknown]> = [
        ["a missing name", { quantity: 1 }],
        ["an empty name", { name: "", quantity: 1 }],
        ["a whitespace-only name", { name: " \t\n ", quantity: 1 }],
        ["a name of 65 characters", { name: "x".repeat(65), quantity: 1 }],
        ["a name of 65 characters plus padding", { name: ` ${"x".repeat(65)} `, quantity: 1 }],
        ["a numeric name", { name: 5, quantity: 1 }],
        ["a null name", { name: null, quantity: 1 }],
        ["an object name", { name: { first: "x" }, quantity: 1 }],
        ["a missing quantity", { name: "gear" }],
        ["a negative quantity", { name: "gear", quantity: -1 }],
        ["a fractional quantity", { name: "gear", quantity: 1.5 }],
        ["a string quantity", { name: "gear", quantity: "5" }],
        ["a null quantity", { name: "gear", quantity: null }],
        ["a boolean quantity", { name: "gear", quantity: true }],
        ["a NaN quantity", { name: "gear", quantity: Number.NaN }],
        ["an infinite quantity", { name: "gear", quantity: Number.POSITIVE_INFINITY }],
        ["an empty object", {}],
        ["undefined", undefined],
        ["null", null],
        ["a string", "gear"],
        ["a number", 3],
        ["an array", [{ name: "gear", quantity: 1 }]],
    ];

    it.each(rejected)("rejects %s", (_label, payload) => {
        const result = validateWidgetInput(payload);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.details.length).toBeGreaterThan(0);
        expect(result.details.every((detail) => typeof detail === "string" && detail.length > 0)).toBe(true);
    });

    it("reports every problem at once rather than only the first", () => {
        const result = validateWidgetInput({ name: "", quantity: -1 });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.details).toHaveLength(2);
    });
});

describe("WidgetStore", () => {
    const input = { name: "gear", quantity: 3 };

    it("starts empty", () => {
        expect(new WidgetStore().list()).toEqual([]);
    });

    it("creates widgets with a server-generated UUID v4 id and an ISO-8601 UTC createdAt", () => {
        const before = Date.now();
        const widget = new WidgetStore().create(input);
        const after = Date.now();

        expect(widget).toEqual({ id: expect.stringMatching(UUID_V4), name: "gear", quantity: 3, createdAt: expect.stringMatching(ISO_UTC) });
        expect(new Date(widget.createdAt).toISOString()).toBe(widget.createdAt);
        expect(Date.parse(widget.createdAt)).toBeGreaterThanOrEqual(before);
        expect(Date.parse(widget.createdAt)).toBeLessThanOrEqual(after);
    });

    it("gives every widget a distinct id", () => {
        const store = new WidgetStore();
        const ids = new Set(Array.from({ length: 50 }, () => store.create(input).id));
        expect(ids.size).toBe(50);
    });

    it("lists widgets oldest first", () => {
        const store = new WidgetStore();
        const names = ["first", "second", "third"];
        for (const name of names) store.create({ name, quantity: 1 });
        expect(store.list().map((widget) => widget.name)).toEqual(names);
    });

    it("gets a widget by id, and returns undefined for an unknown id", () => {
        const store = new WidgetStore();
        const widget = store.create(input);
        expect(store.get(widget.id)).toEqual(widget);
        expect(store.get("00000000-0000-4000-8000-000000000000")).toBeUndefined();
        expect(store.get("not-a-uuid")).toBeUndefined();
        expect(store.get("__proto__")).toBeUndefined();
    });

    it("deletes a widget once: true the first time, false afterwards and for unknown ids", () => {
        const store = new WidgetStore();
        const widget = store.create(input);
        expect(store.delete(widget.id)).toBe(true);
        expect(store.get(widget.id)).toBeUndefined();
        expect(store.delete(widget.id)).toBe(false);
        expect(store.delete("never-existed")).toBe(false);
        expect(store.list()).toEqual([]);
    });

    it("hands out copies, so callers cannot mutate what is stored", () => {
        const store = new WidgetStore();
        const created = store.create(input);
        created.name = "tampered";
        store.list().forEach((widget) => (widget.quantity = 999));
        const fetched = store.get(created.id);
        if (fetched) fetched.name = "tampered again";

        expect(store.get(created.id)).toMatchObject({ name: "gear", quantity: 3 });
    });

    it("clear() removes everything", () => {
        const store = new WidgetStore();
        store.create(input);
        store.create(input);
        store.clear();
        expect(store.list()).toEqual([]);
    });

    it("keeps separate stores independent", () => {
        const a = new WidgetStore();
        const b = new WidgetStore();
        a.create(input);
        expect(b.list()).toEqual([]);
    });
});
