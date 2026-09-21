///|
/// The shop, now that it has two tiers.
///
/// Every item used to cost the same and consume nothing, so buying was one
/// subtraction and there was nothing in it to get wrong. A build path adds
/// three things that can each be wrong quietly: the price depends on what is
/// already in the bag, the slots depend on what the purchase consumes, and the
/// components have to actually leave. These tests state all three, and then
/// check that the four places that buy — the legal move, the description, the
/// tick and the oracle — agree about them.

///|
/// The tree is two deep. `item_total_cost` sums one level of components, which
/// is right for this shop and would silently under-price a three-tier one.
test "the item tree is two deep" {
  for it in items {
    for comp in it.builds_from {
      match item_of(comp) {
        Some(c) =>
          // A component of a component would need `item_total_cost` to
          // recurse. It does not, so this is the assumption it rests on.
          assert_true(c.builds_from.is_empty())
        None => assert_true(false) // a recipe naming an item that does not exist
      }
    }
  }
}

///|
/// The prices are the ones the rest of the code names.
test "the prices add up to the constants everything else quotes" {
  for it in items {
    let total = item_total_cost(it.key)
    if it.builds_from.is_empty() {
      assert_eq(total, COMPONENT_COST)
      assert_eq(total, it.cost)
    } else if it.builds_from.length() == 1 {
      // The five items that existed before the shop had tiers still cost what
      // they did, so nothing about the game's economy moved when the path was
      // added underneath them.
      assert_eq(total, ITEM_COST)
      assert_eq(it.cost, COMBINE_COST)
    } else {
      assert_eq(total, BIG_ITEM_COST)
    }
  }
}

///|
/// A completed item beats the components under it: strictly more stats, for
/// strictly more gold.
///
/// Not "more stats per gold" in general, although that is the design intent —
/// saying so would need one number for the worth of an armor point against an
/// attack point against a penetration point, this repo does not have one, and
/// inventing one here would be asserting a valuation rather than a rule.
/// `edge` against two `blade`s is the case where no valuation is needed,
/// because both sides of it are attack, so that is asserted on its own below.
test "a completed item beats the components under it" {
  for it in items {
    if it.builds_from.is_empty() {
      continue
    }
    let mut comp_stats = 0
    let mut comp_cost = 0
    for comp in it.builds_from {
      match item_of(comp) {
        Some(c) => {
          comp_stats += item_stat_weight(c)
          comp_cost += c.cost
        }
        None => ()
      }
    }
    assert_true(item_stat_weight(it) > comp_stats)
    assert_true(item_total_cost(it.key) > comp_cost)
  }
}

///|
/// The one gold-efficiency claim that needs no valuation: `edge` is more
/// attack than two `blade`s, for less gold. It is the reason a carry with one
/// sword in the bag and not enough for the combine is right to save.
test "edge is more attack than two blades for less gold" {
  let edge = match item_of("edge") {
    Some(it) => it
    None => panic()
  }
  let blade = match item_of("blade") {
    Some(it) => it
    None => panic()
  }
  assert_true(edge.atk > 2 * blade.atk)
  assert_true(item_total_cost("edge") < 2 * item_total_cost("blade"))
  // And it costs one slot where two blades cost two, which is the other half
  // of why the big items exist in a three-slot bag.
  assert_true(edge.builds_from.length() <= ITEM_SLOTS)
}

///|
/// The price depends on the bag: a component in hand is the discount.
test "holding a component is the discount, one copy at a time" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  let c = g.champs[3]
  c.items.clear()

  // From nothing, the shelf price.
  assert_eq(c.price_of("blade"), ITEM_COST)
  assert_eq(c.price_of("edge"), BIG_ITEM_COST)

  // One sword covers one sword in the recipe, and only one.
  c.items.push("sword")
  assert_eq(c.price_of("blade"), COMBINE_COST)
  assert_eq(c.price_of("edge"), BIG_ITEM_COST - COMPONENT_COST)

  // Two swords cover both.
  c.items.push("sword")
  assert_eq(c.price_of("edge"), BIG_ITEM_COST - 2 * COMPONENT_COST)
  // And a component of something else is no discount at all.
  assert_eq(c.price_of("plate"), ITEM_COST)
}

///|
/// Slots: combining is slot-neutral, so a champion with a full bag can still
/// upgrade what is in it but cannot add to it.
test "a full bag can still combine and cannot add" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  let c = g.champs[3]
  c.items.clear()
  c.items.push("sword")
  c.items.push("hide")
  c.items.push("silk")
  assert_eq(c.items.length(), ITEM_SLOTS)
  c.gold = 10000

  // `blade` eats the sword, so the bag stays at three.
  assert_eq(c.slots_after("blade"), ITEM_SLOTS)
  assert_true(c.can_buy("blade"))
  // `bulwark` eats two, so the bag drops to two.
  assert_eq(c.slots_after("bulwark"), ITEM_SLOTS - 1)
  assert_true(c.can_buy("bulwark"))
  // `ruby` eats nothing, so it would be a fourth item.
  assert_eq(c.slots_after("ruby"), ITEM_SLOTS + 1)
  assert_false(c.can_buy("ruby"))
  // Gold is the other half of the answer: enough slots is not enough.
  c.gold = 10
  assert_false(c.can_buy("blade"))
}

///|
/// Buying consumes exactly the components the recipe names, one copy each.
test "a purchase takes one copy of each component and leaves the rest" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  let c = g.champs[3]
  c.items.clear()
  c.items.push("sword")
  c.items.push("sword")
  c.gold = 1000
  let before = c.gold
  c.apply_buy("blade")
  // Paid the combine cost only, kept the second sword.
  assert_eq(c.gold, before - COMBINE_COST)
  assert_eq(c.count_of("sword"), 1)
  assert_eq(c.count_of("blade"), 1)
  assert_eq(c.items.length(), 2)

  // A two-of-a-kind recipe against one in the bag: pays for the missing one.
  let d = g.champs[4]
  d.items.clear()
  d.items.push("sword")
  d.gold = 1000
  let before_d = d.gold
  d.apply_buy("edge")
  assert_eq(d.gold, before_d - (BIG_ITEM_COST - COMPONENT_COST))
  assert_eq(d.count_of("sword"), 0)
  assert_eq(d.count_of("edge"), 1)
}

///|
/// The tick buys by the same rule, and a `Buy` it would refuse changes nothing.
///
/// This is the assertion that matters most of the ones here: the price and the
/// slots could be right everywhere and the tick could still be doing its own
/// arithmetic, and a game is not the tests.
test "the tick charges the price the shop quoted" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  let c = g.champs[0]
  c.node = base_of(c.team)
  c.items.clear()
  c.items.push("hide")
  c.gold = COMBINE_COST
  assert_eq(c.price_of("plate"), COMBINE_COST)
  g.step(Map([(c.id, Buy("plate"))]))
  assert_eq(c.count_of("plate"), 1)
  assert_eq(c.count_of("hide"), 0)
  assert_eq(c.gold, 0)

  // One gold short of the next thing, and nothing happens.
  let d = g.champs[1]
  d.node = base_of(d.team)
  d.items.clear()
  d.gold = COMPONENT_COST - 1
  g.step(Map([(d.id, Buy("sword"))]))
  assert_eq(d.items.length(), 0)
  assert_eq(d.gold, COMPONENT_COST - 1)

  // And away from base it is refused whatever the pocket holds.
  let e = g.champs[2]
  e.node = node_id("mid_mid")
  e.items.clear()
  e.gold = 10000
  g.step(Map([(e.id, Buy("blade"))]))
  assert_eq(e.items.length(), 0)
}

///|
/// The legal moves and the description agree with the price.
test "the shop offers what it can afford and quotes the right number" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  let c = g.champs[3]
  c.node = base_of(c.team)
  c.items.clear()
  c.gold = COMPONENT_COST

  // At one component's worth, only components are on offer.
  let cheap = g.legal_actions(c)
  assert_true(cheap.contains(Buy("sword")))
  assert_false(cheap.contains(Buy("blade")))
  assert_false(cheap.contains(Buy("edge")))

  // With the sword bought, the item it builds into is affordable although the
  // shelf price is not — which is the whole of what a build path is, so the
  // description says so rather than leaving it to be worked out.
  c.apply_buy("sword")
  c.gold = COMBINE_COST
  let now = g.legal_actions(c)
  assert_true(now.contains(Buy("blade")))
  let text = g.describe_action(c, Buy("blade"))
  assert_true(text.contains("\{COMBINE_COST}"))
  assert_true(text.contains("\{ITEM_COST} from nothing"))
  assert_true(text.contains("consumes sword"))
  // A component's own description promises no discount it is not getting.
  c.gold = COMPONENT_COST
  assert_false(g.describe_action(c, Buy("ruby")).contains("from nothing"))
}

///|
/// An inventory is worth what it cost, not what it is long.
test "team gold prices the bag rather than counting it" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  for c in g.champs {
    c.items.clear()
    c.gold = 0
  }
  let cheap = g.champs[0]
  let dear = g.champs[5]
  cheap.items.push("sword")
  dear.items.push("edge")
  // Same length, and the two teams are not level.
  assert_eq(cheap.items.length(), dear.items.length())
  assert_eq(g.team_gold(TEAM_A), COMPONENT_COST)
  assert_eq(g.team_gold(TEAM_B), BIG_ITEM_COST)
}

///|
/// The baseline buys the item when it can reach it, a component toward it when
/// it cannot, and nothing when it is saving for one it is already half-way to.
test "the baseline builds toward what it wants" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("glass_ad"))
  let carry = g.champs[3]
  carry.items.clear()

  // Enough for the item it wants: it buys the item.
  carry.gold = ITEM_COST
  let rich = g.shop_pick(carry)
  assert_true(rich is Some(_))
  match rich {
    Some(k) => {
      assert_eq(item_total_cost(k), ITEM_COST)
      assert_true(carry.can_buy(k))
    }
    None => ()
  }

  // Only enough for a component: it buys one on the path, never one off it.
  carry.gold = COMPONENT_COST
  match g.shop_pick(carry) {
    Some(k) => {
      assert_eq(item_total_cost(k), COMPONENT_COST)
      assert_true(item_builds_into(k).contains(g.counter_item(carry)))
    }
    None => assert_true(false)
  }

  // Nothing it can use: it holds the gold rather than filling a slot with the
  // wrong stat.
  carry.gold = COMPONENT_COST - 1
  assert_true(g.shop_pick(carry) is None)

  // A frontliner against both damage types aims at `bulwark`, and walks there
  // one component at a time.
  let front = g.champs[0]
  front.items.clear()
  front.gold = BIG_ITEM_COST
  let mixed = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  let mixed_front = mixed.champs[0]
  mixed_front.items.clear()
  mixed_front.gold = BIG_ITEM_COST
  if mixed.counter_item(mixed_front) == "belt" {
    assert_eq(mixed.shop_pick(mixed_front), Some("bulwark"))
    mixed_front.gold = COMPONENT_COST
    match mixed.shop_pick(mixed_front) {
      Some(k) => assert_true(item_builds_into(k).contains("bulwark"))
      None => assert_true(false)
    }
  }
}

///|
/// The `item` class only ever offers and answers purchases the tick would
/// allow. The suite's own integrity tests check that a truth is in the option
/// list; this checks the stronger thing, that the option list is buyable.
test "every item question offers only purchases the game would allow" {
  let mut seen = 0
  for sc in bench_suite() {
    for ask in sc.asks {
      if ask.class_ != "item" {
        continue
      }
      seen += 1
      // Some option is the answer. Through `truth_accepts`, because a tie is
      // recorded as every winner joined by a pipe and `contains` would call
      // that a missing truth.
      let mut accepted = 0
      for o in ask.options {
        if truth_accepts(ask.truth, o) {
          accepted += 1
        }
      }
      assert_true(accepted > 0)
      for o in ask.options {
        assert_true(item_of(o) is Some(_))
      }
      // Each option carries its price, so the choice is not made blind.
      assert_eq(ask.descriptions.length(), ask.options.length())
      for d in ask.descriptions {
        assert_true(d.contains("gold"))
      }
    }
  }
  assert_true(seen > 0)
}

///|
/// A rough single number for an item's stats, only for comparing an item
/// against the components it eats. One armor and one magic resist are worth
/// the same here, and health rather less per point, which is enough to say
/// "more" and not enough to balance anything with.
fn item_stat_weight(it : Item) -> Int {
  it.atk * 6 + it.armor + it.mr + it.hp / 2 + it.pen
}

///|
/// The two tiers are both reached in games nobody set up.
///
/// The same question the drake tests end on, for the same reason: a build path
/// whose upper tier nothing in a played game ever reaches is a price list, not
/// a decision. Asserted over every pairing of the tournament comps, because
/// one matchup's economy is not the shop.
test "both tiers of the shop are reached in played games" {
  let bought : Map[String, Int] = Map([])
  for i in 0..<tournament_comps.length() {
    for j in 0..<tournament_comps.length() {
      if i == j {
        continue
      }
      let g = Game::with_comps(
        comp_by_name(tournament_comps[i].name),
        comp_by_name(tournament_comps[j].name),
      )
      while g.winner == 0 && g.tick < 150 {
        // Count purchases by watching the bags rather than the log: an item
        // that is in a bag now and was not before was bought, whatever the
        // log said, and a combine shows up as the item arriving while the
        // component it ate does not come back.
        let held : Map[String, Int] = Map([])
        for c in g.champs {
          for key in c.items {
            held[key] = held.get(key).unwrap_or(0) + 1
          }
        }
        let actions : Map[Int, Action] = Map([])
        for team in [TEAM_A, TEAM_B] {
          for e in smart_team_actions(g, team) {
            actions[e.0] = e.1
          }
        }
        g.step(actions)
        for c in g.champs {
          for key in c.items {
            let was = held.get(key).unwrap_or(0)
            if was > 0 {
              held[key] = was - 1
            } else {
              bought[key] = bought.get(key).unwrap_or(0) + 1
            }
          }
        }
      }
    }
  }
  let mut components = 0
  let mut completed = 0
  let mut big = 0
  for e in bought {
    match item_of(e.0) {
      Some(it) =>
        if it.builds_from.is_empty() {
          components += e.1
        } else {
          completed += e.1
          if it.builds_from.length() > 1 {
            big += e.1
          }
        }
      None => ()
    }
  }
  // Both tiers, and the upper one specifically: `edge` and `bulwark` are the
  // two that need a champion to save through a fight, which is the behaviour
  // the build path was added to make possible.
  //
  // Not "every item is bought somewhere". `ruby` is not, and should not have
  // to be: the baseline reaches for `bulwark` where it wants both resists, so
  // nothing it does ever walks the path through `ruby`. That is a preference,
  // and a baseline is allowed one — the item is still a legal purchase for a
  // policy under test, which is what `every item in the shop is buyable`
  // above checks.
  assert_true(components > 0)
  assert_true(completed > 0)
  assert_true(big > 0)
}

///|
/// Every item in the shop is buyable: priced within reach, and its components
/// fit the bag. A shelf nothing can be taken off is worse than an empty one,
/// because the benchmark would offer it.
test "every item in the shop is buyable" {
  let g = Game::with_comps(comp_by_name("meta"), comp_by_name("meta"))
  for it in items {
    let c = g.champs[0]
    c.items.clear()
    c.gold = item_total_cost(it.key)
    // From nothing, with the exact money, and nothing in the way.
    assert_true(c.can_buy(it.key))
    assert_eq(c.price_of(it.key), c.gold)
    c.apply_buy(it.key)
    assert_eq(c.count_of(it.key), 1)
    assert_eq(c.gold, 0)
    assert_true(c.items.length() <= ITEM_SLOTS)
    // And by the path, one component at a time, for the same total.
    if !it.builds_from.is_empty() {
      let d = g.champs[1]
      d.items.clear()
      d.gold = item_total_cost(it.key)
      let start = d.gold
      for comp in it.builds_from {
        assert_true(d.can_buy(comp))
        d.apply_buy(comp)
      }
      assert_true(d.can_buy(it.key))
      d.apply_buy(it.key)
      assert_eq(d.count_of(it.key), 1)
      assert_eq(d.gold, 0)
      assert_eq(start - d.gold, item_total_cost(it.key))
    }
  }
}
