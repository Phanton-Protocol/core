// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract Groth16Verifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant deltax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant deltay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant deltay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;

    
    uint256 constant IC0x = 18970289752321906619223425747947305128763548312465020750177984000448506028615;
    uint256 constant IC0y = 11880897364187633372781165095588193204854758249878331141923274094731876567982;
    
    uint256 constant IC1x = 9518996975429647153973624380560017741175579823129160764872980294568869139744;
    uint256 constant IC1y = 616096062685626617732182963620674597838435265689798583577059080551544659506;
    
    uint256 constant IC2x = 4415079853838981119875882991084041874309630766262401904295160119188553566622;
    uint256 constant IC2y = 18137805364266043070953330469459212534115351323906806752337447441706857731283;
    
    uint256 constant IC3x = 6309678510509474078751048816533869527848687159320720562080205129833799161194;
    uint256 constant IC3y = 10910979851860970973049670418198492885440804522309855079194030485555465321121;
    
    uint256 constant IC4x = 13571011981563526095033355106144648105561903523788575721599269542888777145716;
    uint256 constant IC4y = 11122782545845849355509001157451818683581409137362100477705437617966296292336;
    
    uint256 constant IC5x = 4061403258981666715877665049764757004609845235955253748613201410523761323424;
    uint256 constant IC5y = 7277160502564065304598048840951447840592145178435930832419109033657280596202;
    
    uint256 constant IC6x = 17735371315144267679039630866993173875248204055328494611259831376778917962554;
    uint256 constant IC6y = 3450648660853206985825597793095002060909729258792082015648846533078301505916;
    
    uint256 constant IC7x = 1976555800529257309951825542740763053132765051062510623307059789959212539730;
    uint256 constant IC7y = 19189317116310028951238080180408038271854792991854306508623580272921745744911;
    
    uint256 constant IC8x = 18446838736216649193688795506305103984349923124511082135758138853611402092203;
    uint256 constant IC8y = 20074184517969416894415654567381544084433816047787527827201355219367401988103;
    
    uint256 constant IC9x = 2579412746078214173535944012906832347958927156876395176183058482628758001464;
    uint256 constant IC9y = 796836826006525702816389710948293572327379181751238973040811014595667153062;
    
    uint256 constant IC10x = 17837639152806465106146101523662359744185646938283192593981190501453272438258;
    uint256 constant IC10y = 12907571900714904299835162874381630825976915984300766506623384186247428750403;
    
    uint256 constant IC11x = 21884377370897778662421768777054276218574944952300276159174017897617540065430;
    uint256 constant IC11y = 12588081426594342608402647996255377543728373376076843375291743153334132870360;
    
    uint256 constant IC12x = 10498423035088940472166416647968952044429138523599478908115414411550594253254;
    uint256 constant IC12y = 5966389901921570028318891211359576626000160425305811814259710735282599849683;
    
    uint256 constant IC13x = 14341830291264193352923143681956684471768183995510794653001997449462978256716;
    uint256 constant IC13y = 8603431267206240215774858868818374546245005179328730341050294085335053410111;
    
    uint256 constant IC14x = 593547554878136537855411968175204560561639515696903991057860888738885814234;
    uint256 constant IC14y = 18866995313515890716665978733756701676864721947406953272708440881868803893465;
    
    uint256 constant IC15x = 19155974149175640904316170666797978475775294478135671382391023084668557560699;
    uint256 constant IC15y = 5278088124705604124093843634555881612939996773834268445568551447977793814504;
    
    uint256 constant IC16x = 9109100198838920417744742783987662242346292088092327828584065852505593127449;
    uint256 constant IC16y = 3708142075677662339659933512000250701156224094978265934107530299158940797805;
    
    uint256 constant IC17x = 1551404114692069102257730930617412349168602523201744274023337147740518783324;
    uint256 constant IC17y = 6843791922925103395872841690135734101646676983530702593968651481773441601706;
    
    uint256 constant IC18x = 625607765806656348214706231037564382301590293349492352596371747640812065974;
    uint256 constant IC18y = 21851219712695451700645841752256378140448050350179673628246719024241310889103;
    
    uint256 constant IC19x = 18065175441833191002357513926531282198152985747951255238235193202866729891077;
    uint256 constant IC19y = 16836128221960091362361400023714677115602007410184181952120766318527341279797;
    
    uint256 constant IC20x = 18592164126070362662680090152662043075025694825294547850093179028523387570365;
    uint256 constant IC20y = 10867455648555916320713947300791837214619008179640032253365474971412843628935;
    
    uint256 constant IC21x = 20501339621807746957195846474875080253180431418433566624911896494295818424123;
    uint256 constant IC21y = 4682596220868137294205827077137732794965390547451283649882534555086600828747;
    
    uint256 constant IC22x = 6089203110007741594816671016879158645151668143650153510877876998168892814833;
    uint256 constant IC22y = 18383186156862634092672167686910520963616800732153148554763889213656580474483;
    
    uint256 constant IC23x = 9967699867689079418125693841099675685284213339227398471150488390452835363387;
    uint256 constant IC23y = 4362819215384911995044043340721770996971601881782690041224217520639480706462;
    
    uint256 constant IC24x = 702646449293058575516452564687806382672685437245976709161446468015273969697;
    uint256 constant IC24y = 13433082044494265718799045171941063263339572597328519870252410629927053965670;
    
    uint256 constant IC25x = 8671901914145223246375468679018072855572072036213896663755080971239354817392;
    uint256 constant IC25y = 17930262329349908258920020261388253543941746850339543585787765433332475708745;
    
    uint256 constant IC26x = 3046221481648732742983924208505603779352338898324634917079419341142771758206;
    uint256 constant IC26y = 10451694000327429944096744878410911433842095955341663747228150085509186298577;
    
    uint256 constant IC27x = 21296539359031390500283892702255758214046973606847528680217822168659599419482;
    uint256 constant IC27y = 1995309451572186883082932816622875181737315719548019882236281674941696811733;
    
    uint256 constant IC28x = 16884304388335201599758996179115575406010473720460411241310105463673122995132;
    uint256 constant IC28y = 15932081522884398435775594914539889601110571739668682104626573475668933062157;
    
    uint256 constant IC29x = 12811648004620077915884965594924836503011779933371304655700545511636553817953;
    uint256 constant IC29y = 14048178321892052133209667670632098492464751798829213409516502786401758984962;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[29] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                
                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))
                
                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))
                
                g1_mulAccC(_pVk, IC21x, IC21y, calldataload(add(pubSignals, 640)))
                
                g1_mulAccC(_pVk, IC22x, IC22y, calldataload(add(pubSignals, 672)))
                
                g1_mulAccC(_pVk, IC23x, IC23y, calldataload(add(pubSignals, 704)))
                
                g1_mulAccC(_pVk, IC24x, IC24y, calldataload(add(pubSignals, 736)))
                
                g1_mulAccC(_pVk, IC25x, IC25y, calldataload(add(pubSignals, 768)))
                
                g1_mulAccC(_pVk, IC26x, IC26y, calldataload(add(pubSignals, 800)))
                
                g1_mulAccC(_pVk, IC27x, IC27y, calldataload(add(pubSignals, 832)))
                
                g1_mulAccC(_pVk, IC28x, IC28y, calldataload(add(pubSignals, 864)))
                
                g1_mulAccC(_pVk, IC29x, IC29y, calldataload(add(pubSignals, 896)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            
            checkField(calldataload(add(_pubSignals, 576)))
            
            checkField(calldataload(add(_pubSignals, 608)))
            
            checkField(calldataload(add(_pubSignals, 640)))
            
            checkField(calldataload(add(_pubSignals, 672)))
            
            checkField(calldataload(add(_pubSignals, 704)))
            
            checkField(calldataload(add(_pubSignals, 736)))
            
            checkField(calldataload(add(_pubSignals, 768)))
            
            checkField(calldataload(add(_pubSignals, 800)))
            
            checkField(calldataload(add(_pubSignals, 832)))
            
            checkField(calldataload(add(_pubSignals, 864)))
            
            checkField(calldataload(add(_pubSignals, 896)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
