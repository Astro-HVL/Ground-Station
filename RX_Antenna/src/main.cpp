#include <Arduino.h>
#include <SPI.h>
#include <RadioLib.h>
#include <esp_task_wdt.h>

#define WDT_TIMEOUT_S 10

RF69 radio = new Module(14, 26, 27);

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
    Serial.println(state);
  }

  radio.startReceive();
}