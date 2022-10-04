const moduleID = 'pf2-flat-check';

const actorConditionMap = {
    'Blinded': -Infinity, //Just so it gets picked up. DC partially depends on target.
    'Dazzled': 5
};

const targetConditionMap = {
    'Concealed': 5,
    'Hidden': 11,
    'Invisible': 11, //Treated as Undetected
    'Undetected': 11
};


Hooks.once("init", () => {
    game.settings.register(moduleID, 'hideRollValue', {
        name: 'Show "Success" or "Failure" Text',
        scope: 'world',
        config: true,
        type: Boolean,
        default: false
    });
});

Hooks.on('createChatMessage', async (message, data, userID) => {
    if (game.user.id !== game.users.find(u => u.isGM && u.active).id) return;
    const v10 = !foundry.utils.isNewerVersion("10.0", game.version ?? game.data.version);

    const { token, actor } = message;
    let { item } = message;
    const originUUID = v10 ? message.flags.pf2e?.origin?.uuid : message.data.flags.pf2e?.origin?.uuid;
    if (!item && !message.isDamageRoll && originUUID?.match(/Item.(\w+)/) && RegExp.$1 === 'xxPF2ExUNARMEDxx') {
        const actionIds = originUUID.match(/Item.(\w+)/);
        if (actionIds && actionIds[1]) {
            if (v10) {
                item = actor?.system?.actions.filter((atk) => atk?.type === "strike").filter((a) => a.item.id === actionIds[1]) || null;
            } else {
                item = actor?.data.data?.actions.filter((atk) => atk?.type === "strike").filter((a) => a.item.id === actionIds[1]) || null;
            }
        }
    }
    if (!actor || !item) return;
    if (['ancestry', 'effect', 'feat', 'melee', 'weapon'].includes(item.type) && (!message.isRoll || message.isDamageRoll)) return;
    if (item.type === 'spell' && message.isRoll) return;

    const templateData = {};
    const { conditionName, DC } = getCondition(token, null, item.type === 'spell');
    templateData.flatCheckDC = DC ?? 0;
    templateData.actor = { name: token?.name || actor.name, condition: conditionName };

    templateData.targets = [];
    const targets = Array.from(game.users.get(userID).targets);
    let anyTargetUndetected = false;
    for (const target of targets) {
        const { conditionName, DC } = getCondition(token, target, item.type === 'spell');
        if (!conditionName) continue;

        templateData.targets.push({
            name: target.name,
            condition: conditionName
        });

        if (DC > templateData.flatCheckDC) templateData.flatCheckDC = DC;
        if (target.actor.itemTypes?.condition.map(n=>n.name)?.includes('Undetected')) anyTargetUndetected = true;
    }

    if (!templateData.actor.condition && !templateData.targets.length) return;

    const flatCheckRoll = await new Roll('1d20').roll({async: true});
    if (game.dice3d) await game.dice3d.showForRoll(flatCheckRoll, game.users.get(userID), true);

    templateData.flatCheckRollResult = !game.settings.get(moduleID, 'hideRollValue')
        ? flatCheckRoll.result
        : flatCheckRoll.result < templateData.flatCheckDC
            ? 'Failure'
            : 'Success';

    templateData.flatCheckRollResultClass =
        flatCheckRoll.result < templateData.flatCheckDC
            ? 'flat-check-failure'
            : 'flat-check-success';

    const content = await renderTemplate(`modules/${moduleID}/templates/flat-check.hbs`, templateData);
    await ChatMessage.create({
        content: content,
        speaker: ChatMessage.getSpeaker({ token, actor, user: game.users.get(userID) }),
        whisper: anyTargetUndetected ? ChatMessage.getWhisperRecipients("GM").map((u) => u.id) : null,
        blind: anyTargetUndetected
    });
});


function distanceBetween(token0, token1) {
  const ray = new Ray(new PIXI.Point(token0?.x || 0, token0?.y || 0), new PIXI.Point(token1?.x || 0, token1?.y || 0));
  const x = Math.ceil(Math.abs(ray.dx / canvas.dimensions.size));
  const y = Math.ceil(Math.abs(ray.dy / canvas.dimensions.size));
  return Math.floor(Math.min(x, y) + Math.abs(y - x)) * canvas.dimensions.distance;
};


function getCondition(token, target, isSpell) {
    const checkingAttacker = target === null;
    const currentActor = checkingAttacker ? token?.actor : target?.actor;
    const conditionMap = checkingAttacker ? { ...actorConditionMap } : targetConditionMap;
    const attackerBlinded = !!token.actor?.items?.find(i=>i.slug === "blinded");
    const attackerDazzled = !!token.actor?.items?.find(i=>i.slug === "dazzled");
    const attackerHasBlindFight = !!token.actor?.items?.find((i) => i.slug === "blind-fight");
    //Approximation of adjacency on a square grid with snap to grid on, ignoring elevation (so as to avoid having to implement the more complex pf2e rules).
    const attackerAdjacent = distanceBetween(token, target) <= 5;
    const attackerEqualOrHigherLevel = (token.actor?.level || -Infinity) >= (target?.actor?.level || Infinity);

    const conditions = currentActor.itemTypes.condition
      .filter(c => {
          if (checkingAttacker && isSpell) {
              const isStupefy = c.name === game.i18n.localize('PF2E.ConditionTypeStupefied');
              if (isStupefy) return true;
          }
          return Object.keys(conditionMap).includes(c.name);
      })
      .map(c => c.name)
      .sort();

    if (!checkingAttacker && attackerBlinded && !conditions.includes('Hidden')) conditions.push('Hidden');
    if (!checkingAttacker && attackerDazzled && !conditions.includes('Concealed')) conditions.push('Concealed');
    // Get darkness conditions
    if (!checkingAttacker) {
        const attackerLowLightVision = token.actor.system.traits.senses.some(s => s.type === 'lowLightVision');
        const targetInDimLight = currentActor.itemTypes.effect.some(e => e.getFlag('pf2e-darkness-effects', 'dimLight'));
        if (targetInDimLight && !attackerLowLightVision && !conditions.includes('Concealed')) conditions.push('Concealed');

        const attackerDarkvision = token.actor.system.traits.senses.some(s => s.type === 'darkvision');
        const targetInDarkness = currentActor.itemTypes.effect.some(e => e.getFlag('pf2e-darkness-effects', 'darkness'));
        if (targetInDarkness && !attackerDarkvision && !conditions.includes('Hidden')) conditions.push('Hidden');
    }
    if (!conditions.length) return {};

    let stupefyLevel;
    if (conditions.includes(game.i18n.localize('PF2E.ConditionTypeStupefied'))) {
        stupefyLevel = currentActor.itemTypes.condition.find(c => c.name === game.i18n.localize('PF2E.ConditionTypeStupefied'))?.value;
        if (stupefyLevel) conditionMap['Stupefied'] = stupefyLevel + 5;
    }

    let condition = conditions.reduce((acc, current) => {
        let currentDC = conditionMap[current];
        if (checkingAttacker && attackerHasBlindFight) {
            if (current === 'Dazzled') currentDC = -Infinity;
        }
        if (!checkingAttacker && attackerHasBlindFight) {
            if (current === 'Concealed') {
                currentDC = -Infinity;
            } else if (current === 'Hidden') {
                currentDC = 5;
            } else if (current === 'Invisible' || current === 'Undetected') {
              if (attackerAdjacent && attackerEqualOrHigherLevel) {
                current = 'Hidden';
                currentDC = 5;
              }
            }
        }
        return conditionMap[acc] > currentDC ? acc : current;
    });
    let DC = conditionMap[condition];
    if (condition === 'Stupefied') condition += ` ${stupefyLevel}`;
    if (DC === -Infinity) return {};
    //The following lines are needed for when reduce doesn't run due to only a single condition being present.
    if (attackerHasBlindFight) {
        if (condition === 'Dazzled' && checkingAttacker) return {};
        if (condition === 'Concealed' && !checkingAttacker) return {};
        if ((condition === 'Invisible' || condition === 'Undetected') && !checkingAttacker && attackerAdjacent && attackerEqualOrHigherLevel) condition = 'Hidden';
        if (condition === 'Hidden') DC = 5;
    }

    return {conditionName: condition, DC};
}
