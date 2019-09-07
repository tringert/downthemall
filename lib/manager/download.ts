"use strict";
// License: MIT

import { CHROME, downloads } from "../browser";
import { Prefs } from "../prefs";
import { PromiseSerializer } from "../pserializer";
import { filterInSitu, parsePath } from "../util";
import { BaseDownload } from "./basedownload";
// eslint-disable-next-line no-unused-vars
import { Manager } from "./man";
import Renamer from "./renamer";
import {
  CANCELABLE,
  CANCELED,
  DONE,
  FORCABLE,
  MISSING,
  PAUSABLE,
  PAUSED,
  QUEUED,
  RUNNING
} from "./state";
import { Preroller } from "./preroller";

type Header = {name: string; value: string};
interface Options {
  conflictAction: string;
  filename: string;
  saveAs: boolean;
  url: string;
  method?: string;
  body?: string;
  incognito?: boolean;
  headers: Header[];
}

export class Download extends BaseDownload {
  public manager: Manager;

  public manId: number;

  public removed: boolean;

  public position: number;

  public error: string;

  constructor(manager: Manager, options: any) {
    super(options);
    this.manager = manager;
    this.start = PromiseSerializer.wrapNew(1, this, this.start);
    this.removed = false;
    this.position = -1;
  }

  markDirty() {
    this.renamer = new Renamer(this);
    this.manager.setDirty(this);
  }

  changeState(newState: number) {
    const oldState = this.state;
    if (oldState === newState) {
      return;
    }
    this.state = newState;
    this.error = "";
    this.manager.changedState(this, oldState, this.state);
    this.markDirty();
  }

  async start() {
    if (this.state !== QUEUED) {
      throw new Error("invalid state");
    }
    if (this.manId) {
      const {manId: id} = this;
      try {
        const state = await downloads.search({id});
        if (state[0].state === "in_progress") {
          this.changeState(RUNNING);
          this.updateStateFromBrowser();
          return;
        }
        if (state[0].state === "complete") {
          this.changeState(DONE);
          this.updateStateFromBrowser();
          return;
        }
        if (!state[0].canResume) {
          throw new Error("Cannot resume");
        }
        // Cannot await here
        // Firefox bug: will not return until download is finished
        downloads.resume(id).catch(() => {});
        this.changeState(RUNNING);
        return;
      }
      catch (ex) {
        this.manager.removeManId(this.manId);
        this.removeFromBrowser();
      }
    }
    if (this.state !== QUEUED) {
      throw new Error("invalid state");
    }
    console.log("starting", this.toString(), this.toMsg());
    this.changeState(RUNNING);

    // Do NOT await
    this.reallyStart();
  }

  private async reallyStart() {
    try {
      if (!this.prerolled) {
        await this.maybePreroll();
        if (this.state !== RUNNING) {
          // Aborted by preroll
          return;
        }
      }
      const options: Options = {
        conflictAction: await Prefs.get("conflict-action"),
        filename: this.dest.full,
        saveAs: false,
        url: this.url,
        headers: [],
      };
      if (!CHROME && this.private) {
        options.incognito = true;
      }
      if (this.postData) {
        options.body = this.postData;
        options.method = "POST";
      }
      if (!CHROME && this.referrer) {
        options.headers.push({
          name: "Referer",
          value: this.referrer
        });
      }
      if (this.manId) {
        this.manager.removeManId(this.manId);
      }

      try {
        this.manager.addManId(
          this.manId = await downloads.download(options), this);
      }
      catch (ex) {
        if (!this.referrer) {
          throw ex;
        }
        // Re-attempt without referrer
        filterInSitu(options.headers, h => h.name !== "Referer");
        this.manager.addManId(
          this.manId = await downloads.download(options), this);
      }
      this.markDirty();
    }
    catch (ex) {
      console.error("failed to start download", ex.toString(), ex);
      this.changeState(CANCELED);
      this.error = ex.toString();
    }
  }

  private async maybePreroll() {
    try {
      if (this.prerolled) {
        // Check again, just in case, async and all
        return;
      }
      const roller = new Preroller(this);
      if (!roller.shouldPreroll) {
        return;
      }
      const res = await roller.roll();
      if (!res) {
        return;
      }
      if (res.mime) {
        this.mime = res.mime;
      }
      if (res.name) {
        this.serverName = res.name;
      }
      if (res.error) {
        this.cancel();
        this.error = res.error;
      }
    }
    catch (ex) {
      console.error("Failed to preroll", this, ex.toString(), ex.stack, ex);
    }
    finally {
      if (this.state === RUNNING) {
        this.prerolled = true;
        this.markDirty();
      }
    }
  }

  resume(forced = false) {
    if (!(FORCABLE & this.state)) {
      return;
    }
    if (this.state !== QUEUED) {
      this.changeState(QUEUED);
    }
    if (forced) {
      this.manager.startDownload(this);
    }
  }

  async pause() {
    if (!(PAUSABLE & this.state)) {
      return;
    }
    if (this.state === RUNNING && this.manId) {
      try {
        await downloads.pause(this.manId);
      }
      catch (ex) {
        console.error("pause", ex.toString(), ex);
        return;
      }
    }
    this.changeState(PAUSED);
  }

  reset() {
    this.prerolled = false;
    this.manId = 0;
    this.written = this.totalSize = 0;
    this.mime = this.serverName = this.browserName = "";
  }

  async removeFromBrowser() {
    const {manId: id} = this;
    try {
      await downloads.cancel(id);
    }
    catch (ex) {
      // ingored
    }
    await new Promise(r => setTimeout(r, 1000));
    try {
      await downloads.erase({id});
    }
    catch (ex) {
      console.error(id, ex.toString(), ex);
      // ingored
    }
  }

  cancel() {
    if (!(CANCELABLE & this.state)) {
      return;
    }
    if (this.manId) {
      this.manager.removeManId(this.manId);
      this.removeFromBrowser();
    }
    this.reset();
    this.changeState(CANCELED);
  }

  setMissing() {
    if (this.manId) {
      this.manager.removeManId(this.manId);
      this.removeFromBrowser();
    }
    this.reset();
    this.changeState(MISSING);
  }

  async maybeMissing() {
    if (!this.manId) {
      return null;
    }
    const {manId: id} = this;
    try {
      const dls = await downloads.search({id});
      if (!dls.length) {
        this.setMissing();
        return this;
      }
    }
    catch (ex) {
      console.error("oops", id, ex.toString(), ex);
      this.setMissing();
      return this;
    }
    return null;
  }

  adoptSize(state: any) {
    const {
      bytesReceived,
      totalBytes,
      fileSize
    } = state;
    this.written = Math.max(0, bytesReceived);
    this.totalSize = Math.max(0, fileSize >= 0 ? fileSize : totalBytes);
  }

  async updateStateFromBrowser() {
    try {
      const state = (await downloads.search({id: this.manId})).pop();
      const {filename, error} = state;
      const path = parsePath(filename);
      this.browserName = path.name;
      this.adoptSize(state);
      if (!this.mime && state.mime) {
        this.mime = state.mime;
      }
      this.markDirty();
      switch (state.state) {
      case "in_progress":
        if (error) {
          this.cancel();
          this.error = error;
        }
        else {
          this.changeState(RUNNING);
        }
        break;

      case "interrupted":
        if (state.paused) {
          this.changeState(PAUSED);
        }
        else {
          this.cancel();
          this.error = error || "";
        }
        break;

      case "complete":
        this.changeState(DONE);
        break;
      }
    }
    catch (ex) {
      console.error("failed to handle state", ex.toString(), ex.stack, ex);
      this.setMissing();
    }
  }
}
