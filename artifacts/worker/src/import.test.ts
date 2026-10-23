// The import command's two pure steps: turning a sharing link into a download, and naming the shoot after the file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadUrl, nameFrom } from "./import";

test("a Drive sharing link becomes its direct download; any other URL is fetched as given", () => {
  assert.equal(downloadUrl("https://drive.google.com/file/d/1vDW-x_9/view?usp=drive_web"),
    "https://drive.usercontent.google.com/download?id=1vDW-x_9&export=download&confirm=t");
  assert.equal(downloadUrl("https://drive.google.com/open?id=abc"), "https://drive.usercontent.google.com/download?id=abc&export=download&confirm=t");
  assert.equal(downloadUrl("https://example.com/a.mov"), "https://example.com/a.mov");
});

test("the shoot is named after the file, without its extension", () => {
  assert.equal(nameFrom('attachment; filename="Adductor Stretch.mov"', "https://x/y"), "Adductor Stretch");
  assert.equal(nameFrom("attachment; filename*=UTF-8''Banana%20and%20Wishbone.mov", "https://x/y"), "Banana and Wishbone");
  assert.equal(nameFrom(null, "https://example.com/files/Hamstring%20Stretch.mov"), "Hamstring Stretch");
});
