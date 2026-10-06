export type Example = {
  id: string;
  name: string;
  detail: string;
  source: string;
};

const halcyon = `/dts-v1/;

/memreserve/ 0x88000000 0x00010000;

/ {
    model = "Halcyon HC1 Evaluation Board";
    compatible = "halcyon,hc1-evk", "halcyon,hc1";
    #address-cells = <1>;
    #size-cells = <1>;

    aliases {
        serial0 = &uart0;
        serial1 = &uart1;
        i2c0 = &i2c1;
        mmc0 = &usdhc1;
        ethernet0 = &fec;
    };

    chosen {
        stdout-path = "serial0:115200n8";
        bootargs = "console=ttyS0,115200 rootwait";
    };

    cpus {
        #address-cells = <1>;
        #size-cells = <0>;

        cpu@0 {
            device_type = "cpu";
            compatible = "arm,cortex-a53";
            reg = <0>;
            enable-method = "psci";
            clock-frequency = <1200000000>;
        };

        cpu@1 {
            device_type = "cpu";
            compatible = "arm,cortex-a53";
            reg = <1>;
            enable-method = "psci";
            clock-frequency = <1200000000>;
        };
    };

    memory@80000000 {
        device_type = "memory";
        reg = <0x80000000 0x40000000>;
    };

    reserved-memory {
        #address-cells = <1>;
        #size-cells = <1>;
        ranges;

        linux,cma {
            compatible = "shared-dma-pool";
            reusable;
            size = <0x14000000>;
            alloc-ranges = <0x80000000 0x40000000>;
            linux,cma-default;
        };
    };

    clocks {
        clk24m: clock {
            compatible = "fixed-clock";
            #clock-cells = <0>;
            clock-frequency = <24000000>;
            clock-output-names = "osc24m";
        };
    };

    soc {
        compatible = "simple-bus";
        #address-cells = <1>;
        #size-cells = <1>;
        ranges;

        intc: interrupt-controller@a01000 {
            compatible = "arm,gic-400";
            reg = <0xa01000 0x1000>, <0xa02000 0x2000>;
            interrupt-controller;
            #interrupt-cells = <3>;
        };

        clk: clock-controller@a10000 {
            compatible = "halcyon,hc1-ccm";
            reg = <0xa10000 0x4000>;
            #clock-cells = <1>;
            clocks = <&clk24m>;
            clock-names = "osc";
        };

        pinctrl: pinctrl@a20000 {
            compatible = "halcyon,hc1-pinctrl";
            reg = <0xa20000 0x4000>;

            uart0grp: uart0-grp {
                pins = "gpio1-io02", "gpio1-io03";
                bias-pull-up;
                drive-strength = <40>;
            };

            uart1grp: uart1-grp {
                pins = "gpio1-io04", "gpio1-io05";
                bias-disable;
            };
        };

        gpio1: gpio@a30000 {
            compatible = "halcyon,hc1-gpio";
            reg = <0xa30000 0x1000>;
            gpio-controller;
            #gpio-cells = <2>;
            interrupt-controller;
            #interrupt-cells = <2>;
            interrupts = <0 32 4>;
            interrupt-parent = <&intc>;
        };

        uart0: serial@a40000 {
            compatible = "halcyon,hc1-uart", "ns16550a";
            reg = <0xa40000 0x1000>;
            interrupts = <0 33 4>;
            interrupt-parent = <&intc>;
            clocks = <&clk 17>;
            clock-names = "per";
            status = "disabled";
        };

        uart1: serial@a41000 {
            compatible = "halcyon,hc1-uart", "ns16550a";
            reg = <0xa41000 0x1000>;
            interrupts = <0 34 4>;
            interrupt-parent = <&intc>;
            clocks = <&clk 18>;
            clock-names = "per";
            pinctrl-names = "default";
            pinctrl-0 = <&uart1grp>;
            status = "okay";
        };

        i2c1: i2c@a50000 {
            compatible = "halcyon,hc1-i2c";
            reg = <0xa50000 0x1000>;
            interrupts = <0 35 4>;
            interrupt-parent = <&intc>;
            clocks = <&clk 22>;
            #address-cells = <1>;
            #size-cells = <0>;
            status = "okay";

            eeprom@50 {
                compatible = "atmel,24c32";
                reg = <0x50>;
                pagesize = <32>;
                label = "board-id";
            };

            temp@48 {
                compatible = "ti,tmp102";
                reg = <0x48>;
                status = "okay";
            };
        };

        spi0: spi@a60000 {
            compatible = "halcyon,hc1-spi";
            reg = <0xa60000 0x1000>;
            interrupts = <0 36 4>;
            #address-cells = <1>;
            #size-cells = <0>;
            status = "okay";

            flash@0 {
                compatible = "jedec,spi-nor";
                reg = <0>;
                spi-max-frequency = <40000000>;
                m25p,fast-read;
            };
        };

        usdhc1: mmc@a70000 {
            compatible = "halcyon,hc1-usdhc";
            reg = <0xa70000 0x1000>;
            interrupts = <0 37 4>;
            bus-width = <4>;
            no-1-8-v;
            non-removable;
            status = "okay";
        };

        fec: ethernet@a80000 {
            compatible = "halcyon,hc1-fec";
            reg = <0xa80000 0x4000>;
            interrupts = <0 38 4>;
            phy-mode = "rgmii-id";
            phy-handle = <&ethphy0>;
            local-mac-address = [00 1a 2b 3c 4d 5e];
            status = "okay";

            mdio {
                #address-cells = <1>;
                #size-cells = <0>;

                ethphy0: ethernet-phy@1 {
                    compatible = "ethernet-phy-ieee802.3-c22";
                    reg = <1>;
                };
            };
        };

        usb@a90000 {
            compatible = "halcyon,hc1-usb";
            reg = <0xa90000 0x200>;
            interrupts = <0 39 4>;
            dr_mode = "otg";
            status = "disabled";
        };
    };

    leds {
        compatible = "gpio-leds";

        heartbeat {
            label = "hc1:green:status";
            gpios = <&gpio1 4 0>;
            linux,default-trigger = "heartbeat";
        };

        user {
            label = "hc1:amber:user";
            gpios = <&gpio1 5 0>;
            default-state = "off";
        };
    };

    gpio-keys {
        compatible = "gpio-keys";

        key-power {
            label = "Power";
            gpios = <&gpio1 8 1>;
            linux,code = <116>;
            wakeup-source;
        };
    };

    regulators {
        reg_3v3: regulator-3v3 {
            compatible = "regulator-fixed";
            regulator-name = "3V3";
            regulator-min-microvolt = <3300000>;
            regulator-max-microvolt = <3300000>;
            regulator-always-on;
        };
    };
};
`;

const overlay = `/dts-v1/;
/plugin/;

#include <dt-bindings/gpio/gpio.h>
#define GPIO_ACTIVE_LOW 1

/* A board plus the fragments that a cape would apply on top of it.
   The include is not expanded; GPIO_ACTIVE_LOW stays a symbol. */

/ {
    model = "Halcyon HC1 with cape";
    compatible = "halcyon,hc1-cape", "halcyon,hc1";
    #address-cells = <1>;
    #size-cells = <1>;

    soc {
        compatible = "simple-bus";
        ranges;

        uart0: serial@a40000 {
            compatible = "halcyon,hc1-uart";
            status = "disabled";
        };

        i2c1: i2c@a50000 {
            compatible = "halcyon,hc1-i2c";
            #address-cells = <1>;
            #size-cells = <0>;
            status = "okay";

            temp@48 {
                compatible = "ti,tmp102";
                reg = <0x48>;
            };
        };

        gpio1: gpio@a30000 {
            compatible = "halcyon,hc1-gpio";
            gpio-controller;
            #gpio-cells = <2>;
        };
    };

    leds: leds {
        compatible = "gpio-leds";
    };
};

&uart0 {
    status = "okay";
    pinctrl-names = "default";
    pinctrl-0 = <&uart0grp>;
};

&i2c1 {
    /delete-node/ temp@48;

    humidity@40 {
        compatible = "aosong,am2320";
        reg = <0x40>;
    };
};

&leds {
    cape {
        label = "hc1:blue:cape";
        gpios = <&gpio1 9 GPIO_ACTIVE_LOW>;
    };
};

&not_on_this_board {
    status = "okay";
};
`;

const minimal = `/dts-v1/;

/ {
    model = "Tiny";
    compatible = "example,tiny";
    #address-cells = <1>;
    #size-cells = <1>;

    memory@0 {
        device_type = "memory";
        reg = <0x0 0x8000000>;
    };

    uart: serial@1000 {
        compatible = "example,uart";
        reg = <0x1000 0x100>;
        status = "okay";
    };
};

&uart {
    current-speed = <115200>;
};
`;

export const examples: Example[] = [
  {
    id: "halcyon",
    name: "Halcyon HC1",
    detail: "Evaluation board",
    source: halcyon.trim() + "\n",
  },
  {
    id: "overlay",
    name: "Cape overlay",
    detail: "Fragments merged in",
    source: overlay.trim() + "\n",
  },
  {
    id: "minimal",
    name: "Minimal",
    detail: "A dozen lines",
    source: minimal.trim() + "\n",
  },
];

export const defaultExample = examples[0];
