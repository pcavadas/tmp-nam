// Flows against the in-page mock backend (src/lib/mock.ts), one per page.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type AddOutcome } from "../lib/api";
import { resetMockWifi } from "../lib/mock";
import App from "../App";

const wait = { timeout: 4000 };

describe("Captures", () => {
  it("lists the unit's captures with the A2 size picker", async () => {
    render(<App />);
    expect(
      await screen.findByRole(
        "heading",
        { name: "Fender Deluxe Reverb '65 Vibrato" },
        wait,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Captures", { selector: "h1" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/4 on unit/)).toBeInTheDocument();
    const sizes = screen.getByRole("radiogroup", {
      name: "Size the player loads",
    });
    expect(within(sizes).getByRole("radio", { name: /Full/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByText("Connected · NAM card")).toBeInTheDocument();
  });

  it("notes that a size change applies next time", async () => {
    render(<App />);
    await screen.findByRole(
      "heading",
      { name: "Fender Deluxe Reverb '65 Vibrato" },
      wait,
    );
    expect(screen.queryByText("Output gain")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /Lite/ }));
    expect(await screen.findByText("Saved to the unit")).toBeInTheDocument();
  });

  it("changes size without resending gain and explicitly clears Full", async () => {
    const save = vi.spyOn(api, "unitSetOptions");
    try {
      render(<App />);
      await screen.findByRole(
        "heading",
        { name: "Fender Deluxe Reverb '65 Vibrato" },
        wait,
      );
      const before = (await api.unitList()).models[0];
      if (!before) throw new Error("missing mock capture");
      expect(before.options.output_gain).toBeDefined();
      await userEvent.click(screen.getByRole("radio", { name: /Lite/ }));
      await screen.findByText("Saved to the unit");
      expect(save).toHaveBeenLastCalledWith(before.sha256, { size: 0 });
      expect((await api.unitList()).models[0]?.options.output_gain).toBe(
        before.options.output_gain,
      );
      await userEvent.click(screen.getByRole("radio", { name: /Full/ }));
      await waitFor(() => {
        expect(save).toHaveBeenLastCalledWith(before.sha256, { size: null });
      });
      await waitFor(async () => {
        const after = (await api.unitList()).models[0];
        if (!after) throw new Error("missing mock capture");
        expect(after.options.size).toBeUndefined();
        expect(after.options.output_gain).toBe(before.options.output_gain);
      });
    } finally {
      save.mockRestore();
    }
  });

  it("warns about unreliable settings until a successful refresh", async () => {
    const original = await api.unitList();
    const list = vi.spyOn(api, "unitList").mockResolvedValue({
      models: original.models.map((m) => ({ ...m, options: {} })),
      settings_error: "Cannot read /data/nam/player.json.",
    });
    try {
      render(<App />);
      expect(
        await screen.findByText("Player settings unavailable", {}, wait),
      ).toBeInTheDocument();
      expect(screen.getByText(/Current size is unknown/)).toBeInTheDocument();
      const sizes = screen.getAllByRole("radio");
      expect(sizes.length).toBeGreaterThan(0);
      for (const size of sizes)
        expect(size).toHaveAttribute("aria-checked", "false");
      list.mockResolvedValue(original);
      await userEvent.click(
        screen.getByRole("button", { name: "Refresh settings" }),
      );
      await waitFor(() =>
        expect(
          screen.queryByText("Player settings unavailable"),
        ).not.toBeInTheDocument(),
      );
      expect(
        screen
          .getAllByRole("radio")
          .some((size) => size.getAttribute("aria-checked") === "true"),
      ).toBe(true);
    } finally {
      list.mockRestore();
    }
  });

  it("shows settings errors even when no captures are installed", async () => {
    const list = vi.spyOn(api, "unitList").mockResolvedValue({
      models: [],
      settings_error: "Invalid player settings in /data/nam/player.json.",
    });
    try {
      render(<App />);
      expect(
        await screen.findByText("Player settings unavailable", {}, wait),
      ).toBeInTheDocument();
      expect(screen.getByText("No captures on the unit")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Refresh settings" }),
      ).toBeEnabled();
    } finally {
      list.mockRestore();
    }
  });

  it("shows the recovery warning and backup location after saving options", async () => {
    const warning =
      "Invalid player settings were reset. Backup: /data/nam/player.json.invalid.example. Reselect the capture on the unit.";
    const save = vi.spyOn(api, "unitSetOptions").mockResolvedValue(warning);
    try {
      render(<App />);
      await screen.findByRole(
        "heading",
        { name: "Fender Deluxe Reverb '65 Vibrato" },
        wait,
      );
      await userEvent.click(screen.getByRole("radio", { name: /Full/ }));
      expect(
        await screen.findByText("Player settings recovered"),
      ).toBeInTheDocument();
      expect(screen.getByText(warning)).toBeInTheDocument();
      expect(screen.getByText("Saved to the unit")).toBeInTheDocument();
    } finally {
      save.mockRestore();
    }
  });

  it("does not report a save or recovery when settings remain unreadable", async () => {
    const save = vi
      .spyOn(api, "unitSetOptions")
      .mockRejectedValue(
        new Error("cannot read player.json; settings were not changed"),
      );
    try {
      render(<App />);
      await screen.findByRole(
        "heading",
        { name: "Fender Deluxe Reverb '65 Vibrato" },
        wait,
      );
      await userEvent.click(screen.getByRole("radio", { name: /Full/ }));
      expect(
        await screen.findByText(/cannot read player.json/),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Player settings recovered"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Saved to the unit")).not.toBeInTheDocument();
    } finally {
      save.mockRestore();
    }
  });

  it("checks files, sends the valid ones and reports the result", async () => {
    render(<App />);
    await screen.findByRole(
      "heading",
      { name: "Fender Deluxe Reverb '65 Vibrato" },
      wait,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Add Captures…" }),
    );
    const sheet = await screen.findByRole("dialog", {
      name: "Add captures to the unit",
    });
    expect(
      await within(sheet).findByText(/4 files checked\. 3 are valid captures/),
    ).toBeInTheDocument();
    expect(within(sheet).getByText("Skipped")).toBeInTheDocument();
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Send 3 Captures" }),
    );
    expect(
      await screen.findByText("3 captures added", {}, wait),
    ).toBeInTheDocument();
    expect(screen.getAllByText("New")).toHaveLength(3);
    // Sent over the HID channel: no engine restart, so NAM keeps playing.
    expect(
      screen.queryByText("Reselect your preset on the unit"),
    ).not.toBeInTheDocument();
  });

  it("asks for a reselect when the send needed an engine restart", async () => {
    window.history.replaceState(null, "", "/?restart=1");
    try {
      render(<App />);
      await screen.findByRole(
        "heading",
        { name: "Fender Deluxe Reverb '65 Vibrato" },
        wait,
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Add Captures…" }),
      );
      const sheet = await screen.findByRole("dialog", {
        name: "Add captures to the unit",
      });
      await userEvent.click(
        await within(sheet).findByRole("button", { name: "Send 3 Captures" }),
      );
      expect(
        await screen.findByText("Reselect your preset on the unit", {}, wait),
      ).toBeInTheDocument();
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});

describe("Tone3000", () => {
  it("asks for an API key before signing in", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Tone3000" }));
    expect(
      await screen.findByText("Install tones from your Tone3000 account"),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("API key"), "t3k_pub_abc");
    await userEvent.click(screen.getByRole("button", { name: "Save Key" }));
    expect(
      await screen.findByRole("button", { name: "Sign In with Browser" }),
    ).toBeInTheDocument();
  });
});

describe("Tone3000 captures", () => {
  it("installs selected captures of a tone with several", async () => {
    render(<App />);
    await screen.findByRole(
      "heading",
      { name: "Fender Deluxe Reverb '65 Vibrato" },
      wait,
    );
    await userEvent.click(screen.getByRole("button", { name: "Tone3000" }));
    const key = await screen
      .findByLabelText("API key", {}, wait)
      .catch(() => null);
    if (key) {
      await userEvent.type(key, "t3k_pub_abc");
      await userEvent.click(screen.getByRole("button", { name: "Save Key" }));
    }
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign In with Browser" }, wait),
    );
    await userEvent.click(
      await screen.findByRole(
        "button",
        { name: "Show captures of Boss SD-1 Super Overdrive" },
        wait,
      ),
    );
    await userEvent.click(screen.getByLabelText("Select APP-SD1-Drive-I"));
    await userEvent.click(screen.getByLabelText("Select APP-SD1-Boost-I"));
    expect(screen.getByText("2 captures from 1 tone")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Select Boss SD-1 Super Overdrive"),
    ).toHaveAttribute("aria-checked", "mixed");
    await userEvent.click(
      screen.getByRole("button", { name: "Install 2 on Unit" }),
    );
    expect(
      await screen.findByText("2 captures installed", {}, wait),
    ).toBeInTheDocument();
  });
});

describe("SD Card", () => {
  it("verifies the firmware and lists cards with refusals", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "SD Card" }));
    expect(
      await screen.findByText("Not a card reader", {}, wait),
    ).toBeInTheDocument();
    const create = screen.getByRole("button", { name: "Create SD Card…" });
    expect(create).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Choose File…" }));
    expect(await screen.findByText("Verified")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("radio", { name: /Generic STORAGE DEVICE/ }),
    );
    expect(create).toBeEnabled();
    await userEvent.click(create);
    expect(
      await screen.findByRole("alertdialog", {
        name: "Erase this card and create the NAM card?",
      }),
    ).toBeInTheDocument();
  });
});

describe("Settings", () => {
  it("offers diagnostics instead of raw unit details", async () => {
    render(<App />);
    await screen.findByRole(
      "heading",
      { name: "Fender Deluxe Reverb '65 Vibrato" },
      wait,
    );
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("tab", { name: "Unit" }));
    expect(screen.queryByText("nam-card-2026.10-r1")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy Diagnostics" }),
    ).toBeInTheDocument();
  });
});

describe("Settings › Wi-Fi", () => {
  beforeEach(resetMockWifi);

  async function openWifi() {
    render(<App />);
    await screen.findByRole(
      "heading",
      { name: "Fender Deluxe Reverb '65 Vibrato" },
      wait,
    );
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("tab", { name: "Wi-Fi" }));
    // The page scans when it opens; actions wait for it.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Scan Again" })).toBeEnabled();
    }, wait);
    return screen.getByRole("list", { name: "Networks" });
  }

  const row = (list: HTMLElement, ssid: string) =>
    within(within(list).getByRole("listitem", { name: ssid }));

  /** A promise the test settles by hand. */
  function pending<T>() {
    let settle: (v: T) => void = () => undefined;
    const promise = new Promise<T>((r) => {
      settle = r;
    });
    return { promise, settle };
  }

  it("lists networks with actions by type: connected, saved, then signal", async () => {
    const list = await openWifi();
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.getAttribute("aria-label")),
    ).toEqual([
      "Studio",
      "Rehearsal Room",
      "Neighbours 5G",
      "New Router",
      "Cafe Guest",
      "Office",
    ]);
    const studio = row(list, "Studio");
    expect(studio.getByText("Connected")).toBeInTheDocument();
    expect(
      studio.getByRole("button", { name: "Forget Studio" }),
    ).toBeInTheDocument();
    expect(studio.queryByRole("button", { name: "Join Studio" })).toBeNull();
    const saved = row(list, "Rehearsal Room");
    expect(saved.getByText("Saved")).toBeInTheDocument();
    expect(
      saved.getByRole("button", { name: "Join Rehearsal Room" }),
    ).toHaveTextContent(/^Join$/);
    expect(
      row(list, "Neighbours 5G").getByRole("button", {
        name: "Join Neighbours 5G",
      }),
    ).toHaveTextContent("Join…");
    expect(
      row(list, "Cafe Guest").getByRole("button", { name: "Join Cafe Guest" }),
    ).toHaveTextContent("Join…");
    expect(row(list, "Office").getByText("Not supported")).toBeInTheDocument();
    expect(row(list, "Office").queryByRole("button")).toBeNull();
    expect(screen.getByRole("switch", { name: "Wi-Fi" })).toBeChecked();
    expect(screen.getByText("192.168.1.57")).toBeInTheDocument();
  });

  it("joins a new network once the password is valid", async () => {
    const list = await openWifi();
    await userEvent.click(
      row(list, "Neighbours 5G").getByRole("button", {
        name: "Join Neighbours 5G",
      }),
    );
    const sheet = screen.getByRole("dialog", { name: "Join “Neighbours 5G”" });
    const join = within(sheet).getByRole("button", { name: "Join" });
    const field = within(sheet).getByLabelText("Password");
    await userEvent.type(field, "short");
    expect(join).toBeDisabled();
    await userEvent.type(field, "{Enter}");
    expect(
      within(sheet).getByText(/Use 8 to 63 characters/),
    ).toBeInTheDocument();
    await userEvent.clear(field);
    await userEvent.type(field, "password1{Enter}");
    expect(
      await screen.findByText(/^Address 192\.168\.1\.57\./, undefined, wait),
    ).toBeInTheDocument();
    expect(
      row(list, "Neighbours 5G").getByText("Connected"),
    ).toBeInTheDocument();
  });

  it("reports a wrong password for a new network and offers to join again", async () => {
    const list = await openWifi();
    await userEvent.click(
      row(list, "Neighbours 5G").getByRole("button", {
        name: "Join Neighbours 5G",
      }),
    );
    await userEvent.type(
      screen.getByLabelText("Password"),
      "wrongpass1{Enter}",
    );
    expect(
      await screen.findByText(
        "Wrong password for Neighbours 5G",
        undefined,
        wait,
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Join Again…" }));
    expect(
      screen.getByRole("dialog", { name: "Join “Neighbours 5G”" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("says a saved network's password changed and that the unit forgot it", async () => {
    const list = await openWifi();
    await userEvent.click(
      row(list, "Rehearsal Room").getByRole("button", {
        name: "Join Rehearsal Room",
      }),
    );
    expect(
      await screen.findByText(
        "The password for Rehearsal Room has changed",
        undefined,
        wait,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/so the unit forgot it/)).toBeInTheDocument();
    expect(row(list, "Rehearsal Room").queryByText("Saved")).toBeNull();
    expect(
      row(list, "Rehearsal Room").getByRole("button", {
        name: "Join Rehearsal Room",
      }),
    ).toHaveTextContent("Join…");
  });

  it("forgets a network after confirming", async () => {
    const list = await openWifi();
    await userEvent.click(
      row(list, "Studio").getByRole("button", { name: "Forget Studio" }),
    );
    const confirm = screen.getByRole("alertdialog", {
      name: "Forget “Studio”?",
    });
    expect(
      within(confirm).getByText(/It disconnects from Studio now/),
    ).toBeInTheDocument();
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Forget" }),
    );
    expect(
      await screen.findByText("Forgot Studio", undefined, wait),
    ).toBeInTheDocument();
    expect(
      screen.getByText("On · not connected to a network"),
    ).toBeInTheDocument();
  });

  it("drops a network it couldn't forget because it's out of range", async () => {
    const forget = vi
      .spyOn(api, "wifiForget")
      .mockResolvedValue("out_of_range");
    try {
      const list = await openWifi();
      await userEvent.click(
        row(list, "Rehearsal Room").getByRole("button", {
          name: "Forget Rehearsal Room",
        }),
      );
      await userEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", {
          name: "Forget",
        }),
      );
      expect(
        await screen.findByText(
          "Couldn't forget Rehearsal Room",
          undefined,
          wait,
        ),
      ).toBeInTheDocument();
      expect(
        within(list).queryByRole("listitem", { name: "Rehearsal Room" }),
      ).toBeNull();
    } finally {
      forget.mockRestore();
    }
  });

  it("keeps Wi-Fi on when the saved setting says off", async () => {
    window.history.replaceState(null, "", "/?wifi=differs");
    resetMockWifi();
    const set = vi.spyOn(api, "wifiSetEnabled");
    try {
      await openWifi();
      expect(
        screen.getByText(/the unit's saved setting is Off/),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Keep It On" }));
      await waitFor(() => {
        expect(
          screen.queryByText(/the unit's saved setting is Off/),
        ).toBeNull();
      }, wait);
      expect(set).toHaveBeenCalledWith(true);
      expect(screen.getByRole("switch", { name: "Wi-Fi" })).toBeChecked();
    } finally {
      set.mockRestore();
      window.history.replaceState(null, "", "/");
    }
  });

  it("disables Wi-Fi controls and sends while a join runs", async () => {
    const joining = pending<"connected">();
    const join = vi.spyOn(api, "wifiJoin").mockReturnValue(joining.promise);
    try {
      const list = await openWifi();
      await userEvent.click(
        row(list, "Rehearsal Room").getByRole("button", {
          name: "Join Rehearsal Room",
        }),
      );
      expect(
        row(list, "Rehearsal Room").getByText("Joining…"),
      ).toBeInTheDocument();
      expect(screen.getByText("Joining Rehearsal Room…")).toBeInTheDocument();
      expect(screen.getByText("Joining Wi-Fi")).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: "Wi-Fi" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Scan Again" })).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Forget Studio" }),
      ).toHaveAttribute("title", "Available when joining finishes");
      await userEvent.click(screen.getByRole("button", { name: /^Captures/ }));
      const add = screen.getByRole("button", { name: "Add Captures…" });
      expect(add).toBeDisabled();
      expect(add).toHaveAttribute(
        "title",
        "Available when the Wi-Fi change finishes",
      );
      joining.settle("connected");
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Add Captures…" }),
        ).toBeEnabled();
      }, wait);
    } finally {
      join.mockRestore();
    }
  });

  it("disables Wi-Fi settings while captures are sent", async () => {
    const sending = pending<AddOutcome>();
    const send = vi.spyOn(api, "unitAddFiles").mockReturnValue(sending.promise);
    try {
      await openWifi();
      await userEvent.click(screen.getByRole("button", { name: /^Captures/ }));
      await userEvent.click(
        screen.getByRole("button", { name: "Add Captures…" }),
      );
      const sheet = await screen.findByRole("dialog", {
        name: "Add captures to the unit",
      });
      await userEvent.click(
        await within(sheet).findByRole("button", { name: "Send 3 Captures" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      await userEvent.click(screen.getByRole("tab", { name: "Wi-Fi" }));
      expect(
        screen.getByText(
          "Captures are being sent over the same USB connection. Wi-Fi settings can't change until that's done.",
        ),
      ).toBeInTheDocument();
      const toggle = screen.getByRole("switch", { name: "Wi-Fi" });
      expect(toggle).toBeDisabled();
      expect(toggle.closest("[title]")).toHaveAttribute(
        "title",
        "Available when the transfer finishes",
      );
      sending.settle({
        added: [],
        failed_after_restart: [],
        not_sent: [],
        needs_restart: false,
      });
      await waitFor(() => {
        expect(screen.getByRole("switch", { name: "Wi-Fi" })).toBeEnabled();
      }, wait);
    } finally {
      send.mockRestore();
    }
  });

  it("reports a failed scan instead of an empty list", async () => {
    const scan = vi
      .spyOn(api, "wifiScan")
      .mockRejectedValue(new Error("The audio engine didn't answer."));
    try {
      render(<App />);
      await screen.findByRole(
        "heading",
        { name: "Fender Deluxe Reverb '65 Vibrato" },
        wait,
      );
      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      await userEvent.click(screen.getByRole("tab", { name: "Wi-Fi" }));
      expect(
        await screen.findByText("Couldn't scan for networks", undefined, wait),
      ).toBeInTheDocument();
      expect(screen.queryByText("No networks found")).toBeNull();
    } finally {
      scan.mockRestore();
    }
  });

  it("turns Wi-Fi off and hides the networks", async () => {
    await openWifi();
    await userEvent.click(screen.getByRole("switch", { name: "Wi-Fi" }));
    expect(await screen.findByText("Off", undefined, wait)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Networks" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Wi-Fi" })).not.toBeChecked();
  });
});
