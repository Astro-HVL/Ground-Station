#include <Arduino.h>
#include <SPI.h>
#include <RadioLib.h>
#include <esp_task_wdt.h>

#define WDT_TIMEOUT_S 10

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
constexpr float RF_RX_BANDWIDTH_KHZ = 125.0;
constexpr int8_t RF_OUTPUT_POWER_DBM = 10;
constexpr uint8_t RF_PREAMBLE_LEN = 16;

RF69 radio = new Module(RADIO_CS_PIN, RADIO_DIO0_PIN, RADIO_RST_PIN);

void haltOnRadioError(int state) {
  Serial.print("Radio init failed, code ");
  Serial.println(state);
  while (true) {
    delay(1000);
  }
}

volatile bool packetReady = false;

void IRAM_ATTR onPacket() {
  packetReady = true;
}

bool initRadio() {
  // Manual reset
  pinMode(27, OUTPUT);
  digitalWrite(27, LOW);
  delay(10);
  digitalWrite(27, HIGH);
  delay(10);

  int state = radio.begin(433.0, 4.8, 5.0, 125.0, 10, 16);
  if (state != RADIOLIB_ERR_NONE) {
    Serial.print("Radio init failed: ");
    Serial.println(state);
    return false;
  }
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(1000);

<<<<<<< HEAD
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);

  SPI.begin(18, 19, 23, 14);

  // Retry init up to 5 times before giving up
  bool ok = false;
  for (int i = 0; i < 5 && !ok; i++) {
    ok = initRadio();
    if (!ok) delay(500);
  }

  if (!ok) {
    Serial.println("Radio failed after retries — halting");
    while (true) delay(100);
  }

  // Interrupt-driven receive
  radio.setPacketReceivedAction(onPacket);
  radio.startReceive();

  Serial.println("RX ready");
}

void loop() {
  esp_task_wdt_reset();

  if (!packetReady) return;
  packetReady = false;

  char buf[64];
  int state = radio.readData(buf, sizeof(buf));

  if (state == RADIOLIB_ERR_NONE) {
    Serial.print("Received: ");
    Serial.println(buf);
    Serial.print("RSSI: ");
    Serial.println(radio.getRSSI());
  } else {
    Serial.print("RX error: ");
=======
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
    Serial.print("Received: ");
    Serial.println(message);
    Serial.print("RSSI: ");
    Serial.print(radio.getRSSI());
    Serial.println(" dBm");
  } else if (state != RADIOLIB_ERR_RX_TIMEOUT) {
    Serial.print("Receive failed, code ");
>>>>>>> 57a1953 (RF sender)
    Serial.println(state);
  }

  radio.startReceive();
}