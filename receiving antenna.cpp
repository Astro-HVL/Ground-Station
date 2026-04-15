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

// Must match the transmitter settings exactly
constexpr float RF_FREQUENCY_MHZ = 433.0;
constexpr float RF_BIT_RATE_KBPS = 4.8;
constexpr float RF_FREQ_DEV_KHZ = 5.0;
constexpr float RF_RX_BANDWIDTH_KHZ = 25.0;
constexpr int8_t RF_OUTPUT_POWER_DBM = 10;
constexpr uint8_t RF_PREAMBLE_LEN = 16;

RF69 radio = new Module(RADIO_CS_PIN, RADIO_DIO0_PIN, RADIO_RST_PIN);

int32_t lastPacketNum = -1;
uint32_t totalReceived = 0;
uint32_t totalLost = 0;

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
  Serial.println("RF69 receiver starting...");

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

  Serial.print("Receiver ready on ");
  Serial.print(RF_FREQUENCY_MHZ, 1);
  Serial.println(" MHz");
}

void loop() {
  String message;
  int state = radio.receive(message);

  if (state == RADIOLIB_ERR_NONE) {
    totalReceived++;

    // Parse packet number from "ASTRO_HVL_PACKET_N"
    int32_t packetNum = -1;
    int idx = message.lastIndexOf('_');
    if (idx >= 0) {
      packetNum = message.substring(idx + 1).toInt();
    }

    if (packetNum >= 0 && lastPacketNum >= 0) {
      int32_t gap = packetNum - lastPacketNum - 1;
      if (gap > 0) {
        totalLost += gap;
        Serial.print("*** LOST ");
        Serial.print(gap);
        Serial.println(" packet(s)! ***");
      }
    }
    if (packetNum >= 0) lastPacketNum = packetNum;

    Serial.print("Received: ");
    Serial.println(message);
    Serial.print("RSSI: ");
    Serial.print(radio.getRSSI());
    Serial.print(" dBm | RX: ");
    Serial.print(totalReceived);
    Serial.print(" Lost: ");
    Serial.println(totalLost);
  } else if (state != RADIOLIB_ERR_RX_TIMEOUT) {
    Serial.print("Receive failed, code ");
    Serial.println(state);
  }

  radio.startReceive();
}