import {
  BasesEntry,
  BasesPropertyId,
  BooleanValue,
  DateValue,
  LinkValue,
  ListValue,
  NullValue,
  setIcon,
  TFile,
  Notice,
  Menu,
  Value,
  Keymap,
  Platform,
  getFrontMatterInfo,
  moment,
  parseYaml,
} from "obsidian";
import { KanbanView } from "./kanban-view";
import { ORDER_PROPERTY, sanitizeFilename } from "./constants";
import { relativeLuminance } from "./color-utils";
import type { OrderValue } from "./order";
import { CardDetailModal } from "./card-detail-modal";

const IMAGE_EXTENSIONS = new Set([
  "apng",
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

// Format a Value for chip display:
//   - DateValue    → relative ("3 days ago")
//   - LinkValue    → alias if set, otherwise basename without .md extension
//                    (e.g. [[folder/Mario]] → "Mario", [[Welcome|Alias]] → "Alias")
//   - ListValue    → comma-separated list of the above, applied recursively
//   - everything else → toString() (existing behaviour)
function formatValueForChip(val: Value): string {
  if (val instanceof DateValue) {
    return val.relative();
  }
  if (val instanceof LinkValue) {
    const raw = val.toString();
    const match = raw.match(/^\[\[([^|\]]+)(?:\|([^\]]+))?\]\]$/);
    if (match) {
      const target = match[1];
      const alias = match[2];
      if (alias) return alias;
      const basename = target.split("/").pop() ?? target;
      return basename.replace(/\.md$/, "");
    }
    return raw;
  }
  if (val instanceof ListValue) {
    const parts: string[] = [];
    const len = val.length();
    for (let i = 0; i < len; i++) {
      const item = val.get(i);
      if (!item || item instanceof NullValue || !item.isTruthy()) continue;
      parts.push(formatValueForChip(item));
    }
    return parts.join(", ");
  }
  return val.toString();
}

// File properties that are redundant (shown as the card title) or are
// complex list types that don't render usefully as a short chip value.
const FILE_PROPS_TO_SKIP = new Set([
  "name",
  "basename",
  "fullname",
  "ext",
  "extension",
  "path",
  "links",
  "backlinks",
  "inlinks",
  "outlinks",
  "embeds",
  "tags",
]);

export class CardManager {
  private view: KanbanView;

  constructor(view: KanbanView) {
    this.view = view;
  }

  public renderCard(
    cardsEl: HTMLElement,
    entry: BasesEntry,
    columnName: string,
    existingCardEl?: HTMLElement | null,
  ): void {
    const filePath = entry.file?.path ?? "";
    const cardEl =
      existingCardEl ?? cardsEl.createDiv({ cls: "base-board-card" });
    const renderVersion = this.getRenderVersion(entry);

    if (existingCardEl) {
      cardsEl.appendChild(cardEl);
      cardEl.dataset.columnName = columnName;
      cardEl.removeClass("base-board-card--dragging");
      cardEl.removeClass("base-board-card--drag-ghost");
      cardEl.removeClass("base-board-card--selected");
      if (cardEl.dataset.renderVersion === renderVersion) return;
      cardEl.innerHTML = "";
    } else {
      cardEl.setAttr("draggable", "true");
      cardEl.dataset.filePath = filePath;
      cardEl.dataset.columnName = columnName;
    }
    cardEl.dataset.renderVersion = renderVersion;

    const file = this.view.app.vault.getAbstractFileByPath(filePath);
    const coverProp = this.view.getCardCoverProperty();
    if (file instanceof TFile && coverProp) {
      const src = this.getCardCoverSrc(file, coverProp);
      if (src) {
        this.renderCardThumbnail(cardEl, src);
      }
    }

    if (!existingCardEl) {
      // Open the note on click; guard against accidental clicks after a drag
      let dragEndTime = 0;
      cardEl.addEventListener("dragend", () => {
        dragEndTime = Date.now();
      });

      cardEl.addEventListener("click", (e: MouseEvent) => {
        if (Date.now() - dragEndTime < 100) return;

        const isAlt = e.altKey;
        const isShift = e.shiftKey;
        const isMod = e.ctrlKey || e.metaKey;

        if ((isAlt || isShift) && !isMod) {
          e.preventDefault();
          this.handleCardSelect(
            filePath,
            cardEl.dataset.columnName ?? columnName,
            isShift,
          );
          return;
        }

        // If there are selected cards, clear them on a plain click instead of opening
        if (this.view.selectedCards.size > 0) {
          this.clearSelection();
          return;
        }

        const file = this.view.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return;

        // Handle standard Obsidian modifiers using Keymap.isModEvent(e)
        const mod = Keymap.isModEvent(e);
        if (mod) {
          e.preventDefault();
          void this.view.app.workspace.getLeaf(mod).openFile(file);
          return;
        }

        const openBehavior = this.view.getCardOpenBehavior();
        if (openBehavior === "split") {
          if (
            this.view.detailLeaf &&
            this.view.isLeafAttached(this.view.detailLeaf)
          ) {
            void this.view.detailLeaf.openFile(file);
          } else {
            this.view.detailLeaf = this.view.app.workspace.getLeaf(
              "split",
              "vertical",
            );
            void this.view.detailLeaf.openFile(file);
          }
        } else if (openBehavior === "tab") {
          void this.view.app.workspace.getLeaf("tab").openFile(file);
        } else if (openBehavior === "active") {
          void this.view.app.workspace.getLeaf(false).openFile(file);
        } else {
          new CardDetailModal(this.view.app, file, this.view).open();
        }
      });

      // Middle-click → always open in new tab
      cardEl.addEventListener("auxclick", (e: MouseEvent) => {
        if (e.button !== 1) return;
        const file = this.view.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return;
        void this.view.app.workspace.getLeaf("tab").openFile(file);
      });

      // Keyboard: Escape clears multi-selection when a card is focused
      cardEl.setAttribute("tabindex", "-1");
      cardEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Escape" && this.view.selectedCards.size > 0) {
          e.preventDefault();
          this.clearSelection();
        }
      });

      // Hover → native Obsidian page-preview popover (same as hovering a [[wikilink]])
      // Use mouseenter (not mouseover) — mouseover bubbles from every child element
      // and would re-trigger the preview on each chip/tag/title crossing.
      cardEl.addEventListener("mouseenter", (evt: MouseEvent) => {
        if (!filePath) return;
        this.view.app.workspace.trigger("hover-link", {
          event: evt,
          source: "base-board",
          hoverParent: this.view,
          targetEl: cardEl,
          linktext: filePath,
        });
      });

      // Right-click → batch move menu when cards are selected, otherwise standard file menu
      cardEl.addEventListener("contextmenu", (e: MouseEvent) => {
        e.preventDefault();
        if (Platform.isMobile) return;
        const file = this.view.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return;

        // If this card is part of a multi-selection, show the batch move menu
        if (
          this.view.selectedCards.size > 1 &&
          this.view.selectedCards.has(filePath)
        ) {
          this.showBatchMoveMenu(e);
          return;
        }

        const menu = new Menu();
        this.view.app.workspace.trigger(
          "file-menu",
          menu,
          file,
          "base-board-card",
          this.view.app.workspace.getMostRecentLeaf(),
        );
        menu.showAtMouseEvent(e);
      });
    }

    const tagContainerEl = cardEl.createDiv({
      cls: "base-board-tag-container",
    });
    if (file instanceof TFile) {
      const fileTags = this.view.tags.extractTagsFromFile(file);
      for (const tag of fileTags) {
        const tagEl = tagContainerEl.createSpan({
          cls: "base-board-card-tag",
          text: tag,
        });
        const color = this.view.tags.getColorForTag(tag);
        if (color) {
          tagEl.style.setProperty("--tag-color", color);
          if (relativeLuminance(color) === "dark") {
            tagEl.addClass("base-board-card-tag-light");
          } else {
            tagEl.addClass("base-board-card-tag-dark");
          }
        }
      }
    }

    const titleEl = cardEl.createDiv({ cls: "base-board-card-title" });

    // Respect cardTitleProperty if configured — use a frontmatter property
    // (e.g. "title") as the card heading instead of the filename.
    let cardTitle = entry.file?.basename ?? "Untitled";
    const titleProp = this.view.config.get("cardTitleProperty") as
      string | undefined;
    if (titleProp) {
      const propId = titleProp.startsWith("note.")
        ? titleProp
        : `note.${titleProp}`;
      const tv = entry.getValue(propId as BasesPropertyId);
      if (tv && !(tv instanceof NullValue) && tv.isTruthy()) {
        cardTitle = formatValueForChip(tv);
      }
    }
    titleEl.createSpan({ text: cardTitle });

    // ---- Edit button (visible on hover) ----
    const editBtn = cardEl.createDiv({ cls: "base-board-card-edit-btn" });
    setIcon(editBtn, "lucide-pencil");
    editBtn.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation(); // Don't open the note
      this.showCardActionMenu(editBtn, filePath, titleEl);
    });

    // ---- Property chips ----
    const propsEl = cardEl.createDiv({ cls: "base-board-card-props" });
    const groupByProp = this.view.getGroupByProperty();
    const visibleProps: BasesPropertyId[] = this.view.config.getOrder();

    // Collect eligible chip descriptors in one pass so filtering logic lives
    // in one place.  No DOM is created yet.
    interface ChipDescriptor {
      propId: string;
      displayName: string;
      display: string;
      val: Value;
      isCheckbox: boolean;
    }

    const chips: ChipDescriptor[] = [];
    for (const propId of visibleProps) {
      if (chips.length >= 6) break;
      if (propId.startsWith("file.")) {
        if (FILE_PROPS_TO_SKIP.has(propId.slice(5))) continue;
      }
      const propName = propId.startsWith("note.") ? propId.slice(5) : propId;
      if (groupByProp && propName === groupByProp) continue;
      if (propName === ORDER_PROPERTY) continue;

      const val = entry.getValue(propId);
      if (!val || val instanceof NullValue) continue;
      // Checkbox properties are meaningful in both states, so an unchecked
      // (false) box must still render as a chip instead of being treated
      // like an empty/falsy value.
      const isCheckbox = val instanceof BooleanValue;
      if (!isCheckbox && !val.isTruthy()) continue;
      const display = formatValueForChip(val);
      if (!isCheckbox && !display) continue;

      chips.push({
        propId,
        displayName: this.view.config.getDisplayName(propId),
        display,
        val,
        isCheckbox,
      });
    }

    const CHIP_VISIBLE = 4;

    // Render visible chips.
    for (let i = 0; i < chips.length && i < CHIP_VISIBLE; i++) {
      this.renderCardChip(propsEl, chips[i], filePath);
    }

    // Overflow chips (if any) go into a collapsible container.
    let overflowEl: HTMLDivElement | null = null;
    for (let i = CHIP_VISIBLE; i < chips.length; i++) {
      if (!overflowEl) {
        overflowEl = propsEl.createDiv({
          cls: "base-board-card-chips-overflow",
        });
      }
      this.renderCardChip(overflowEl, chips[i], filePath);
    }

    // ---- Expand toggle when chips exceed visible threshold ----
    if (overflowEl) {
      const overflowCount = chips.length - CHIP_VISIBLE;
      const toggleBtn = propsEl.createSpan({
        cls: "base-board-card-chip-more",
      });
      toggleBtn.setText(`+${overflowCount} more`);
      toggleBtn.addEventListener("click", (e: MouseEvent) => {
        e.stopPropagation();
        const expanded = overflowEl.classList.toggle(
          "base-board-card-chips-overflow--expanded",
        );
        toggleBtn.setText(expanded ? "show less" : `+${overflowCount} more`);
      });
    }
  }

  private getRenderVersion(entry: BasesEntry): string {
    const file = entry.file;
    const groupByProp = this.view.getGroupByProperty();
    const visibleProperties = this.view.config
      .getOrder()
      .filter((propId) => {
        const propName = propId.startsWith("note.") ? propId.slice(5) : propId;
        return propName !== groupByProp && propName !== ORDER_PROPERTY;
      })
      .map((propId) => {
        const value = entry.getValue(propId);
        const isCheckbox = value instanceof BooleanValue;
        return [
          propId,
          this.view.config.getDisplayName(propId),
          value &&
          !(value instanceof NullValue) &&
          (isCheckbox || value.isTruthy())
            ? formatValueForChip(value)
            : "",
        ];
      });
    const resolvedFile = file
      ? this.view.app.vault.getAbstractFileByPath(file.path)
      : null;
    const tags =
      resolvedFile instanceof TFile
        ? this.view.tags.extractTagsFromFile(resolvedFile)
        : [];
    const coverProperty = this.view.getCardCoverProperty();
    const cover =
      resolvedFile instanceof TFile && coverProperty
        ? this.getCardCoverSrc(resolvedFile, coverProperty)
        : null;
    const titleProperty = this.view.config.get("cardTitleProperty");
    const titleValue =
      typeof titleProperty === "string"
        ? entry.getValue(
            (titleProperty.startsWith("note.")
              ? titleProperty
              : `note.${titleProperty}`) as BasesPropertyId,
          )
        : null;

    return JSON.stringify({
      path: file?.path ?? "",
      basename: file?.basename ?? "",
      cover,
      title:
        titleValue &&
        !(titleValue instanceof NullValue) &&
        titleValue.isTruthy()
          ? formatValueForChip(titleValue)
          : (file?.basename ?? "Untitled"),
      visibleProperties,
      tags,
      tagColors: this.view.tags.getColors(),
    });
  }

  /** Dispatch a chip descriptor to the checkbox or plain-text chip renderer. */
  private renderCardChip(
    parent: HTMLElement,
    chip: {
      propId: string;
      displayName: string;
      display: string;
      val: Value;
      isCheckbox: boolean;
    },
    filePath: string,
  ): HTMLElement {
    const { propId, displayName, display, val, isCheckbox } = chip;
    if (isCheckbox) {
      // Only real frontmatter properties (note.*) can be toggled — a
      // formula-computed boolean has nowhere to write the new value.
      const editable = propId.startsWith("note.");
      return this.renderCheckboxChip(
        parent,
        displayName,
        val.isTruthy(),
        propId,
        filePath,
        editable,
      );
    }
    return this.renderChip(parent, displayName, display, propId, val);
  }

  /** Render a checkbox-property chip; clicking it toggles the frontmatter value. */
  private renderCheckboxChip(
    parent: HTMLElement,
    label: string,
    checked: boolean,
    propId: string,
    filePath: string,
    editable: boolean,
  ): HTMLElement {
    const chip = parent.createSpan({
      cls: "base-board-card-chip base-board-card-chip--checkbox",
    });
    chip.setAttr("data-property-id", propId);

    const checkboxEl = chip.createEl("input", {
      cls: "base-board-card-checkbox",
      attr: { type: "checkbox" },
    });
    checkboxEl.checked = checked;
    checkboxEl.disabled = !editable;

    chip.createSpan({ text: label, cls: "base-board-chip-label" });

    // Stop clicks from bubbling to the card (which opens the note).
    chip.addEventListener("click", (e) => e.stopPropagation());

    if (editable) {
      checkboxEl.addEventListener("change", () => {
        const propName = propId.startsWith("note.") ? propId.slice(5) : propId;
        if (propName === "__proto__" || propName === "constructor") return;
        const file = this.view.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return;
        const newValue = checkboxEl.checked;
        void this.view.app.fileManager.processFrontMatter(
          file,
          (fm: Record<string, unknown>) => {
            fm[propName] = newValue;
          },
        );
      });
    }

    return chip;
  }

  /** Create a single chip span with label + value inside the given parent. */
  private renderChip(
    parent: HTMLElement,
    label: string,
    value: string,
    propId?: string,
    val?: Value,
  ): HTMLElement {
    const chip = parent.createSpan({ cls: "base-board-card-chip" });
    if (propId) chip.setAttr("data-property-id", propId);
    chip.createSpan({ text: label, cls: "base-board-chip-label" });
    const valueEl = chip.createSpan({ cls: "base-board-chip-value" });
    // Formula properties (e.g. one using html()) resolve to a value whose
    // toString() is raw markup. Render formula output through the Bases
    // renderer so HTML is shown as rich content instead of being escaped to
    // literal text by setText().
    if (val && propId?.startsWith("formula.")) {
      valueEl.addClass("base-board-chip-value--formula");
      val.renderTo(valueEl, this.view.app.renderContext);
    } else {
      valueEl.setText(value);
    }
    return chip;
  }

  private showCardActionMenu(
    anchorEl: HTMLElement,
    filePath: string,
    titleEl: HTMLElement,
  ): void {
    const file = this.view.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof TFile)) return;

    const menu = new Menu();

    menu.addItem((item) => {
      item
        .setTitle("Edit tags")
        .setIcon("lucide-tags")
        .onClick(() => {
          this.view.tags.promptEditTags(file);
        });
    });

    menu.addItem((item) => {
      item
        .setTitle("Open")
        .setIcon("lucide-file-text")
        .onClick(() => {
          const openBehavior = this.view.getCardOpenBehavior();
          if (openBehavior === "split") {
            if (
              this.view.detailLeaf &&
              this.view.isLeafAttached(this.view.detailLeaf)
            ) {
              void this.view.detailLeaf.openFile(file);
            } else {
              this.view.detailLeaf = this.view.app.workspace.getLeaf(
                "split",
                "vertical",
              );
              void this.view.detailLeaf.openFile(file);
            }
          } else if (openBehavior === "tab") {
            void this.view.app.workspace.getLeaf("tab").openFile(file);
          } else if (openBehavior === "active") {
            void this.view.app.workspace.getLeaf(false).openFile(file);
          } else {
            new CardDetailModal(this.view.app, file, this.view).open();
          }
        });
    });

    menu.addItem((item) => {
      item
        .setTitle("Open in new tab")
        .setIcon("lucide-file-plus")
        .onClick(() => {
          void this.view.app.workspace.getLeaf("tab").openFile(file);
        });
    });

    menu.addSeparator();

    menu.addItem((item) => {
      item
        .setTitle("Rename")
        .setIcon("lucide-pencil")
        .onClick(() => {
          this.startCardRename(titleEl, file);
        });
    });

    menu.addItem((item) => {
      item
        .setTitle("Delete")
        .setIcon("lucide-trash-2")
        .onClick(async () => {
          await this.view.app.fileManager.trashFile(file);
          new Notice(`Moved "${file.basename}" to trash`);
        });
    });

    const rect = anchorEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.right, y: rect.bottom });
  }

  private startCardRename(titleEl: HTMLElement, file: TFile): void {
    const titleSpan = titleEl.querySelector("span");
    if (!titleSpan) return;

    const input = titleEl.createEl("input");
    input.type = "text";
    input.value = file.basename;
    input.className = "base-board-card-rename-input";

    titleSpan.remove();
    input.focus();
    input.select();

    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const newName = input.value.trim();
      if (newName && newName !== file.basename) {
        const newPath = file.path.replace(
          /[^/]+\.md$/,
          `${sanitizeFilename(newName)}.md`,
        );
        try {
          await this.view.app.fileManager.renameFile(file, newPath);
        } catch (err) {
          new Notice(`Rename failed: ${String(err)}`);
        }
      }
      // Re-render will pick up the new name via onDataUpdated
      this.view.scheduleRender();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        committed = true;
        this.view.scheduleRender();
      }
    });
    input.addEventListener("blur", () => {
      void commit();
    });
  }

  public startInlineCardCreation(
    btnEl: HTMLElement,
    columnName: string,
    targetOrder: OrderValue,
  ): void {
    // Find the cards list for this column.
    // The trigger button may be in the header OR in the footer, so we walk
    // up to the column element and then down into .base-board-cards.
    const columnEl = btnEl.closest(".base-board-column");
    const cardsEl =
      (columnEl?.querySelector(".base-board-cards") as HTMLElement | null) ??
      btnEl.parentElement!;

    btnEl.classList.add("base-board-hidden");

    const inputWrapper = cardsEl.createDiv({
      cls: "base-board-add-card-input-wrapper",
    });
    const input = inputWrapper.createEl("input", {
      cls: "base-board-add-card-input",
      attr: { type: "text", placeholder: "Card title…" },
    });
    input.focus();

    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const name = input.value.trim();
      inputWrapper.remove();
      btnEl.classList.remove("base-board-hidden");
      if (name) {
        await this.createNewCard(name, columnName, targetOrder);
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        committed = true;
        inputWrapper.remove();
        btnEl.classList.remove("base-board-hidden");
      }
    });
    input.addEventListener("blur", () => {
      void commit();
    });
  }

  private async createNewCard(
    title: string,
    columnName: string,
    targetOrder: OrderValue,
  ): Promise<void> {
    const groupByProp = this.view.getGroupByProperty();
    if (!groupByProp) {
      new Notice("Cannot create card: no group by property configured.");
      return;
    }

    const templatePath = this.view.config?.get("newItemTemplate") as
      string | undefined;
    const template = templatePath
      ? await this.loadTemplate(templatePath, title)
      : null;

    const overrides = (fm: Record<string, unknown>) => {
      if (template) {
        for (const key of Object.keys(template.frontmatter)) {
          if (key === "__proto__" || key === "constructor") continue;
          fm[key] = template.frontmatter[key];
        }
      }
      const newItemProps = this.view.config?.get("newItemProperties");
      if (newItemProps && typeof newItemProps === "object") {
        const props = newItemProps as Record<string, unknown>;
        for (const k of Object.keys(props)) {
          if (k !== "__proto__" && k !== "constructor") {
            fm[k] = props[k];
          }
        }
      }
      this.view.applyGroupByValue(fm, groupByProp, columnName);
      fm[ORDER_PROPERTY] = targetOrder;
    };

    const folder = (
      this.view.config?.get("newItemFolder") as string | undefined
    )
      ?.replace(/^\/+|\/+$/g, "")
      .trim();

    try {
      if (template?.body || folder) {
        const filePromise = this.waitForNextFileCreated();
        await this.view.createFileForView(title, overrides);
        const file = await filePromise;
        if (file) {
          if (template?.body) {
            const body = template.body;
            await this.view.app.vault.process(
              file,
              (data) => `${data}\n${body}`,
            );
          }
          if (folder) {
            await this.moveToFolder(file, folder);
          }
        }
      } else {
        await this.view.createFileForView(title, overrides);
      }
    } catch (err) {
      new Notice(`Failed to create card: ${String(err)}`);
    }
  }

  /** Move a freshly-created card into `folder` (relative to the vault root), creating it if needed. */
  private async moveToFolder(file: TFile, folder: string): Promise<void> {
    const targetPath = `${folder}/${file.name}`;
    if (targetPath === file.path) return;
    if (!this.view.app.vault.getAbstractFileByPath(folder)) {
      await this.view.app.vault.createFolder(folder);
    }
    await this.view.app.fileManager.renameFile(file, targetPath);
  }

  /**
   * Read a template note's frontmatter and body, resolving the same
   * {{title}}/{{date}}/{{time}} placeholders as Obsidian's core Templates
   * plugin. Frontmatter values are applied before the board's own overrides
   * (groupBy value, newItemProperties, kanban_order), so the board's
   * configuration always wins over the template's defaults.
   */
  private async loadTemplate(
    templatePath: string,
    title: string,
  ): Promise<{ frontmatter: Record<string, unknown>; body: string } | null> {
    const file = this.view.app.vault.getAbstractFileByPath(templatePath);
    if (!file || !(file instanceof TFile)) {
      new Notice(`Template not found: "${templatePath}"`);
      return null;
    }

    const raw = await this.view.app.vault.cachedRead(file);
    const info = getFrontMatterInfo(raw);
    const rawFrontmatter = info.exists
      ? ((parseYaml(info.frontmatter) as Record<string, unknown>) ?? {})
      : {};

    const frontmatter: Record<string, unknown> = {};
    for (const key of Object.keys(rawFrontmatter)) {
      if (key === "__proto__" || key === "constructor") continue;
      const value = rawFrontmatter[key];
      frontmatter[key] =
        typeof value === "string"
          ? this.resolveTemplateVariables(value, title)
          : value;
    }

    const body = this.resolveTemplateVariables(
      raw.slice(info.contentStart),
      title,
    );

    return { frontmatter, body };
  }

  private resolveTemplateVariables(text: string, title: string): string {
    // Obsidian's own `moment` export types as a namespace rather than the
    // callable moment.js default export, so it needs a cast to invoke.
    const momentFn = moment as unknown as (...args: unknown[]) => {
      format(fmt: string): string;
    };
    return text
      .replace(/\{\{title\}\}/gi, title)
      .replace(/\{\{date(?::([^}]+))?\}\}/gi, (_match, fmt?: string) =>
        momentFn().format(fmt || "YYYY-MM-DD"),
      )
      .replace(/\{\{time(?::([^}]+))?\}\}/gi, (_match, fmt?: string) =>
        momentFn().format(fmt || "HH:mm"),
      );
  }

  /** Resolve with the next .md file the vault reports as created, or null after a short timeout. */
  private waitForNextFileCreated(): Promise<TFile | null> {
    return new Promise((resolve) => {
      // Typed as the generic Events shape (rather than the more specific
      // `(file: TAbstractFile) => any` the 'create' overload of `on` wants)
      // because Vault.off() only declares that generic signature.
      const handler = (...data: unknown[]) => {
        const file = data[0];
        if (!(file instanceof TFile) || file.extension !== "md") return;
        window.clearTimeout(timeout);
        this.view.app.vault.off("create", handler);
        resolve(file);
      };
      const timeout = window.setTimeout(() => {
        this.view.app.vault.off("create", handler);
        resolve(null);
      }, 5000);
      this.view.app.vault.on("create", handler);
    });
  }

  // ---------------------------------------------------------------------------
  //  Multi-select helpers
  // ---------------------------------------------------------------------------

  /**
   * Toggle or range-select a card.
   *
   * - Cmd/Ctrl+click  → toggle this card in/out of the selection
   * - Shift+click     → select a contiguous range from the last-selected card
   *                     to this one (within the same column's DOM order)
   */
  public handleCardSelect(
    filePath: string,
    columnName: string,
    isShift: boolean,
  ): void {
    const sel = this.view.selectedCards;

    if (isShift && sel.size > 0) {
      // Build DOM order for the column
      const columnEl = this.view.containerEl.querySelector(
        `[data-column-name="${CSS.escape(columnName)}"]`,
      );
      if (columnEl) {
        const cardEls = Array.from(
          columnEl.querySelectorAll<HTMLElement>(".base-board-card"),
        );
        const paths = cardEls.map((el) => el.dataset.filePath ?? "");
        const clickedIdx = paths.indexOf(filePath);
        // Find the last card in the current selection that exists in this column
        const lastIdx = paths.reduceRight((found, p, i) => {
          if (found !== -1) return found;
          return sel.has(p) ? i : -1;
        }, -1);
        if (clickedIdx !== -1 && lastIdx !== -1) {
          const [from, to] = [
            Math.min(clickedIdx, lastIdx),
            Math.max(clickedIdx, lastIdx),
          ];
          for (let i = from; i <= to; i++) {
            if (paths[i]) sel.add(paths[i]);
          }
        } else {
          sel.add(filePath); // fallback: just add
        }
      }
    } else {
      // Cmd/Ctrl+click: toggle
      if (sel.has(filePath)) {
        sel.delete(filePath);
      } else {
        sel.add(filePath);
      }
    }

    // Sync visual state on all card elements
    this.view.containerEl
      .querySelectorAll<HTMLElement>(".base-board-card")
      .forEach((el) => {
        if (sel.has(el.dataset.filePath ?? "")) {
          el.addClass("base-board-card--selected");
        } else {
          el.removeClass("base-board-card--selected");
        }
      });
  }

  public clearSelection(): void {
    this.view.selectedCards.clear();
    this.view.containerEl
      .querySelectorAll<HTMLElement>(".base-board-card--selected")
      .forEach((el) => el.removeClass("base-board-card--selected"));
  }

  /**
   * Show a "Move to…" context menu for the current multi-selection.
   * Uses the same `applyBatchUpdate` + `processFrontMatter` pattern as
   * the single-card drag/drop to stay consistent.
   */
  public showBatchMoveMenu(e: MouseEvent): void {
    const selectedPaths = Array.from(this.view.selectedCards);
    const groupByProp = this.view.getGroupByProperty();
    if (!groupByProp) return;

    const columns = this.view.getColumns();
    const menu = new Menu();

    menu.addItem((item) => {
      item.setTitle(`Move ${selectedPaths.length} cards to…`).setDisabled(true);
    });
    menu.addSeparator();

    for (const col of columns) {
      menu.addItem((item) => {
        item.setTitle(col).onClick(() => {
          void this.moveBatchToColumn(selectedPaths, col, groupByProp);
        });
      });
    }

    menu.showAtMouseEvent(e);
  }

  private async moveBatchToColumn(
    filePaths: string[],
    targetColumn: string,
    groupByProp: string,
  ): Promise<void> {
    const selected = new Set(filePaths);
    const orderedPaths = this.view
      .getOrderedPathsForColumn(targetColumn)
      .filter((path) => !selected.has(path));
    orderedPaths.push(...filePaths);

    await this.view.applyBatchUpdate(async () => {
      const updates = filePaths.map((fp) => {
        const file = this.view.app.vault.getAbstractFileByPath(fp);
        if (!file || !(file instanceof TFile)) return Promise.resolve();
        return this.view.app.fileManager.processFrontMatter(
          file,
          (fm: Record<string, unknown>) => {
            this.view.applyGroupByValue(fm, groupByProp, targetColumn);
          },
        );
      });
      await Promise.all(updates);
      await this.view.writeCardOrder(orderedPaths, filePaths);
    });
    this.clearSelection();
    new Notice(
      `Moved ${filePaths.length} card${filePaths.length > 1 ? "s" : ""} to "${targetColumn}"`,
    );
  }

  private getCardCoverSrc(file: TFile, coverPropName: string): string | null {
    if (coverPropName === "__proto__" || coverPropName === "constructor") {
      return null;
    }
    const cache = this.view.app.metadataCache.getFileCache(file);
    const rawValue: unknown = cache?.frontmatter?.[coverPropName];
    if (!rawValue) return null;
    if (typeof rawValue !== "string" && typeof rawValue !== "number")
      return null;

    if (typeof rawValue === "string" && /^https?:\/\//i.test(rawValue)) {
      return rawValue;
    }

    const cleanPath = String(rawValue)
      .replace(/^!?\[\[(.*?)\]\]$/, "$1")
      .split("|")[0]
      .split("#")[0]
      .trim();

    if (!cleanPath) return null;

    const resolved = this.view.app.metadataCache.getFirstLinkpathDest(
      cleanPath,
      file.path,
    );

    if (
      resolved instanceof TFile &&
      IMAGE_EXTENSIONS.has(resolved.extension.toLowerCase())
    ) {
      return this.view.app.vault.getResourcePath(resolved);
    }

    return null;
  }

  private renderCardThumbnail(cardEl: HTMLElement, src: string): void {
    const thumbEl = cardEl.createDiv();
    thumbEl.className = "base-board-card-thumbnail";
    thumbEl
      .createEl("img", {
        cls: "base-board-card-thumbnail-img",
        attr: { src, loading: "lazy" },
      })
      .addEventListener("error", () => {
        thumbEl.remove();
        cardEl.removeClass("base-board-card--has-thumbnail");
      });
    cardEl.prepend(thumbEl);
    cardEl.addClass("base-board-card--has-thumbnail");
  }
}
