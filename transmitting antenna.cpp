#include <Arduino.h>
#include <SPI.h>
#include <RadioLib.h>

// ESP32 <-> RF69 wiring
constexpr uint8_t RADIO_SCK_PIN = 18;
constexpr uint8_t RADIO_MISO_PIN = 19;
constexpr uint8_t RADIO_MOSI_PIN = 23;
constexpr uint8_t RADIO_CS_PIN = 14;
constexpr uint8_t RADIO_DIO0_PIN = 26;
constexpr uint8_t RADIO_RST_PIN = 27;

// Shared radio settings for both ESP32 boards
constexpr float RF_FREQUENCY_MHZ = 433.0;
constexpr float RF_BIT_RATE_KBPS = 4.8;
constexpr float RF_FREQ_DEV_KHZ = 5.0;
constexpr float RF_RX_BANDWIDTH_KHZ = 125.0;
constexpr int8_t RF_OUTPUT_POWER_DBM = 10;
constexpr uint8_t RF_PREAMBLE_LEN = 16;
constexpr unsigned long TX_INTERVAL_MS = 500;

RF69 radio = new Module(RADIO_CS_PIN, RADIO_DIO0_PIN, RADIO_RST_PIN);

uint32_t packetCounter = 0;

void haltOnRadioError(int state) {
  Serial.print("Radio init failed, code ");
  Serial.println(state);
  while (true) {
    delay(1000);
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("RF69 transmitter starting...");

  SPI.begin(RADIO_SCK_PIN, RADIO_MISO_PIN, RADIO_MOSI_PIN, RADIO_CS_PIN);

  int state = radio.begin(
    RF_FREQUENCY_MHZ,
    RF_BIT_RATE_KBPS,
    RF_FREQ_DEV_KHZ,
    RF_RX_BANDWIDTH_KHZ,
    RF_OUTPUT_POWER_DBM,
    RF_PREAMBLE_LEN
  );

  if (state != RADIOLIB_ERR_NONE) {
    haltOnRadioError(state);
  }

  Serial.println("Transmitter ready.");
}

void loop() {
  String payload = "ASTRO_HVL_PACKET_" + String(packetCounter++);
  int state = radio.transmit(payload);

  if (state == RADIOLIB_ERR_NONE) {
    Serial.print("Sent: ");
    Serial.println(payload);
  } else {
    Serial.print("Transmit failed, code ");
    Serial.println(state);
  }

  delay(TX_INTERVAL_MS);
}