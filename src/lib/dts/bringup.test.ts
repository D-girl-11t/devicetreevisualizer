import { describe, expect, test } from "vitest";
import { analyzeBringup } from "./bringup";
import { parseDts } from "./parse";
import { examples } from "./samples";

function board(id: string) {
  const example = examples.find((item) => item.id === id);
  if (!example) throw new Error(id);
  return analyzeBringup(parseDts(example.source));
}

describe("bring-up path", () => {
  test("maps the Halcyon console, pins, driver, and userspace device", () => {
    const halcyon = board("halcyon");
    expect(halcyon.model).toBe("Halcyon HC1 Evaluation Board");
    expect(halcyon.stdout).toBe("serial0:115200n8");
    expect(halcyon.cpus).toBe(2);

    const consoleUart = halcyon.links.find((link) => link.path === "/soc/serial@a40000");
    expect(consoleUart?.aliases).toEqual(["serial0"]);
    expect(consoleUart?.userspace).toBe("/dev/ttyS0");
    expect(consoleUart?.notes.some((note) => note.tone === "warn" && note.message.includes("Boot console"))).toBe(
      true,
    );

    const uart = halcyon.links.find((link) => link.path === "/soc/serial@a41000");
    expect(uart?.pins).toEqual(["uart1grp: gpio1-io04, gpio1-io05"]);
    expect(uart?.kernel.config).toBe("CONFIG_SERIAL_8250");
    expect(uart?.userspace).toBe("/dev/ttyS1");
    expect(uart?.notes.filter((note) => note.tone === "warn")).toEqual([]);

    const sensor = halcyon.links.find((link) => link.compatible.includes("ti,tmp102"));
    expect(sensor?.kernel.config).toBe("CONFIG_SENSORS_TMP102");
    expect(sensor?.userspace).toBe("/sys/class/hwmon (i2c 0-0048)");

    const led = halcyon.links.find((link) => link.userspace.includes("hc1:amber:user"));
    expect(led?.pins[0]).toContain("gpio1 line 5");
    expect(led?.pins[0]).toContain("active-high");

    const i2c = halcyon.links.find((link) => link.path === "/soc/i2c@a50000");
    expect(i2c?.notes.some((note) => note.message.includes("No pin group"))).toBe(true);
  });

  test("the cape shows a missing pin group, a deleted sensor, and the new humidity chip", () => {
    const cape = board("overlay");
    expect(cape.unresolved).toContain("&not_on_this_board");

    const uart = cape.links.find((link) => link.path === "/soc/serial@a40000");
    expect(uart?.status).toBe("okay");
    expect(uart?.notes.some((note) => note.message.includes("&uart0grp"))).toBe(true);

    const removed = cape.links.find((link) => link.path === "/soc/i2c@a50000/temp@48");
    expect(removed?.deleted).toBe(true);

    const humidity = cape.links.find((link) => link.path === "/soc/i2c@a50000/humidity@40");
    expect(humidity?.fromOverlay).toBe(true);
    expect(humidity?.kernel.driver).toBe("humidity sensor");
    expect(humidity?.userspace).toContain("?-0040");

    const capeLed = cape.links.find((link) => link.path === "/leds/cape");
    expect(capeLed?.userspace).toBe("/sys/class/leds/hc1:blue:cape");
    expect(capeLed?.pins[0]).toContain("active-low");
  });
});
