// Plain words, so `awf logs` never takes a marker for a credential and hides it.
const WORDS = `
acorn amber anchor anvil apple apricot arch arrow aspen atlas autumn badger bamboo banjo barley
basket beacon beetle birch biscuit blanket bloom boulder bramble breeze brick bridge bronze
bucket buffalo bundle butter cabin cactus camel candle canoe canyon carrot castle cedar cello
cherry chestnut cinder clover cobalt comet copper coral cotton cricket crystal cypress daisy
dolphin dragon drum eagle ember falcon feather fennel fern fiddle finch flint forest fossil fox
garnet ginger glacier goose granite grape gravel harbor harvest hazel heron hickory honey
horizon iris ivory jasmine juniper kettle kiwi ladder lagoon lantern lemon lichen lily linen
lobster maple marble meadow melon mint mitten moose moss nectar nickel nutmeg oak oasis ocean
olive onyx orchid otter owl paddle panda pebble pepper pine plum pond poppy prairie pumpkin
quail quartz quill rabbit raven reed ribbon river robin rocket saffron sage salmon sapphire
satchel shell silver sparrow spruce squash star stone sunset swan tangerine thistle thunder
timber toast topaz tulip turnip velvet violet walnut walrus willow wren yarrow zephyr
`
  .trim()
  .split(/\s+/);

/** A key's marker: four random plain words, `lantern-copper-walrus-tangerine`. */
export function newMarker(count = 4): string {
  const picks = crypto.getRandomValues(new Uint32Array(count));
  return [...picks].map((n) => WORDS[n % WORDS.length]).join("-");
}
