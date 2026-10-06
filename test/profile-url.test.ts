import { test } from "node:test";
import assert from "node:assert/strict";
import { plausibleProfileUrl } from "../src/profile-url.js";

const ok = (name: string, url: string) => assert.equal(plausibleProfileUrl(name, url), true, `${name} ↔ ${url}`);
const no = (name: string, url: string) => assert.equal(plausibleProfileUrl(name, url), false, `${name} ↔ ${url}`);

test("a slug carrying any part of the name passes", () => {
  ok("Olga Petrik", "https://www.linkedin.com/in/opetrik/");
  ok("Yaroslav Samoiliuk", "https://linkedin.com/in/yaroslavsam");
  ok("Anna Nadeina", "https://www.linkedin.com/in/anna-nadeina-78775046/");
  ok("Tim Rath", "https://de.linkedin.com/in/tim-rath-12ab");
});

test("initial + surname forms pass", () => {
  ok("John Smith", "https://www.linkedin.com/in/jsmith1");
  ok("John Smith", "https://www.linkedin.com/in/smithj");
});

test("diacritics and local letters fold before comparing", () => {
  ok("Žiga Kerec", "https://www.linkedin.com/in/zigakerec/");
  ok("Łukasz Nowak", "https://www.linkedin.com/in/lukasz-nowak-pl");
  ok("Søren Møller", "https://www.linkedin.com/in/soren-moller");
  ok("Jürgen Groß", "https://www.linkedin.com/in/juergen-gross");
});

test("a stranger's slug is rejected", () => {
  no("Ilija Cosic", "https://www.linkedin.com/in/aleksandrstarovoitov/");
  no("Maria Garcia", "https://www.linkedin.com/in/peter-jones-99");
});

test("non-profile and empty URLs are rejected", () => {
  no("Olga Petrik", "https://www.linkedin.com/company/zeely");
  assert.equal(plausibleProfileUrl("Olga Petrik", undefined), false);
});

test("names with nothing to compare are kept rather than guessed about", () => {
  ok("李 伟", "https://www.linkedin.com/in/liwei88");
});
