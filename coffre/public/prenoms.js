/* ADBI Coffre — dictionnaire de prénoms pour la détection des identités.
   En minuscules et SANS accents : la comparaison se fait après normalisation.
   Liste volontairement large (usage France, y compris prénoms d'origine
   maghrébine, africaine, portugaise, italienne, espagnole, slave…) : un
   prénom seul suffit à signaler une identité, l'utilisateur garde la main
   dans l'atelier pour décocher les faux positifs. */

var COFFRE_PRENOMS = new Set((
  "aaron,abdel,abdelkader,abdellah,abdou,abel,adam,adama,adele,adeline,adrien,adriana,agathe,agnes," +
  "ahmed,aicha,aida,aime,aissa,aissatou,alain,alan,alba,albane,albert,alberto,alix,alan,alassane," +
  "alexandre,alexandra,alexia,alexis,ali,alice,alicia,aline,alison,allan,alma,alphonse,amadou," +
  "amel,amelia,amelie,amina,aminata,amine,amir,amira,anais,anas,anatole,andre,andrea,andreas,andy," +
  "ange,angela,angele,angelina,angelique,anis,anissa,anna,annabelle,anne,annie,annick,anthony," +
  "antoine,antonin,antonio,anouk,april,arianne,ariane,ariel,arielle,aristide,armand,armelle,arnaud," +
  "arno,arthur,assia,astrid,athenais,aubin,aude,audrey,augustin,auguste,aurele,aurelie,aurelien," +
  "aurore,axel,axelle,ayoub,azedine,aziz,bakary,baptiste,barbara,basile,bastien,beatrice,belinda," +
  "benjamin,benoit,berenice,bernadette,bernard,bertrand,bilal,billy,blaise,blanche,boris,boubacar," +
  "brahim,brandon,brice,brigitte,bruno,bryan,camelia,camille,candice,capucine,carine,carla,carlos," +
  "carole,caroline,casimir,cassandra,catherine,cecile,cecilia,cedric,celeste,celestin,celia,celine," +
  "cesar,chaima,chantal,charlene,charles,charlie,charline,charlotte,cheick,chloe,christel,christelle," +
  "christian,christiane,christine,christophe,cindy,claire,clara,clarisse,claude,claudia,claudine," +
  "clea,clemence,clement,clementine,cloe,colette,colin,coline,come,constance,constant,constantin," +
  "coralie,corentin,corine,corinne,cyprien,cyril,cyrille,daniel,daniela,danielle,dany,daouda,david," +
  "davy,deborah,delphine,denis,denise,diane,didier,diego,dimitri,dina,dylan,dorian,dorothee,driss," +
  "edgar,edith,edmond,edouard,eleonore,elia,eliane,elias,elie,eliot,eliott,elisa,elisabeth,elise," +
  "ella,ellen,eloane,elodie,eloi,eloise,elsa,elvire,elyes,emeline,emile,emilie,emilien,emma," +
  "emmanuel,emmanuelle,emmy,enora,enzo,eric,erika,erwan,esteban,estelle,esther,ethan,etienne,eva," +
  "evan,eve,eveline,evelyne,fabien,fabienne,fabrice,fadila,fanny,fanta,farid,farida,fatih,fatima," +
  "fatou,fatoumata,faustine,felicie,felix,ferdinand,fernand,fernando,filipe,firmin,flavie,flavien," +
  "flora,flore,florence,florent,florentin,florian,floriane,fode,france,francette,francis,francisco," +
  "franck,francois,francoise,fred,frederic,frederique,gabin,gabriel,gabriela,gabrielle,gael,gaelle," +
  "gaetan,garance,gaspard,gaston,gauthier,gautier,genevieve,geoffrey,geoffroy,georges,georgette," +
  "gerald,geraldine,gerard,germain,germaine,ghislain,ghislaine,gilbert,gilles,gina,gino,giovanni," +
  "giulia,gladys,gloria,gontran,gregoire,gregory,guillaume,gustave,guy,gwenael,gwendoline,gwladys," +
  "habib,hadrien,hakim,hamed,hamza,hanae,hania,hanna,hannah,harold,hassan,hawa,hector,helena,helene," +
  "heloise,henri,henriette,herve,hicham,hind,honore,hortense,houda,hubert,hugo,hugues,hyacinthe," +
  "ibrahim,ibrahima,ida,idir,idriss,ilan,ilham,ilies,ilyes,imane,ines,inaya,irene,iris,isaac," +
  "isabelle,isaure,ismael,issa,ivan,jacky,jacqueline,jacques,jade,jamel,james,jamila,jan,jana," +
  "janine,jason,jean,jeanne,jeannine,jennifer,jeremie,jeremy,jerome,jessica,jimmy,joachim,joan," +
  "joanna,joao,joel,joelle,johan,johanna,john,johnny,jonas,jonathan,jordan,jorge,jose,josee,joseph," +
  "josephine,josette,josiane,joris,joseph,joshua,josue,joy,juan,jude,judith,jules,julia,julian," +
  "julie,julien,julienne,juliette,junior,justin,justine,kader,kadiatou,kamel,kamelia,kamil,karim," +
  "karima,karine,karl,kassim,katia,kelly,kenza,kevin,khadija,khaled,kilian,killian,kim,kylian," +
  "laetitia,lamia,lana,lancelot,lara,larbi,laura,laure,laurence,laurent,laurine,layla,lazare,lea," +
  "leandre,leila,lena,leo,leon,leonard,leonie,leonore,leopold,leslie,lila,lilia,lilian,liliane," +
  "lilou,lily,lina,linda,lino,lionel,lisa,lise,lisette,livio,liz,loan,loane,loic,lola,lorenzo," +
  "lorette,lou,louane,louis,louisa,louise,louna,lounis,luc,luca,lucas,luce,lucette,lucie,lucien," +
  "lucienne,lucile,lucille,ludivine,ludovic,luis,luna,lya,lydia,lydie,maceo,madeleine,mady,mael," +
  "maelle,maelys,maeva,magali,magalie,mahamadou,mahmoud,maia,maissa,malak,malcolm,malek,malika,malo," +
  "mamadou,manel,manon,manuel,marc,marceau,marcel,marcelle,marco,margaux,margot,marguerite,maria," +
  "mariam,mariama,marianne,marie,mariette,marina,marine,mario,marion,marius,marjorie,marlene," +
  "marouane,marthe,martial,martin,martine,marwa,marwan,maryam,maryse,maryvonne,matheo,mathias," +
  "mathieu,mathilde,mathis,mathys,matis,matteo,mattheo,matthias,matthieu,maud,maurice,mauricette," +
  "max,maxence,maxime,maximilien,maya,mederic,mehdi,melanie,melchior,melina,melinda,melissa,melody," +
  "melvin,meriem,merlin,meryem,mia,michael,michel,michele,micheline,mickael,miguel,mila,milan,milo," +
  "mina,mireille,miriam,mohamed,mohammed,moise,mona,monique,morgan,morgane,mory,moussa,mouctar," +
  "mourad,muriel,murielle,mustapha,mya,myriam,nabil,nacer,nada,nadege,nadia,nadine,nadir,nael,nahel," +
  "naila,naim,naima,nans,naomi,naomie,nassim,nathalie,nathan,nathanael,nawel,nazim,nell,nelly,nelson," +
  "neo,nesrine,nessim,nicolas,nicole,nils,nina,nino,ninon,noa,noah,noe,noel,noelle,noemi,noemie," +
  "nolan,nora,norbert,nordine,norman,nour,noura,octave,odette,odile,olga,olivia,olivier,omar,ophelie," +
  "oscar,ousmane,oumar,oumou,pablo,paco,paloma,pamela,paola,paolo,pascal,pascale,pascaline,patrice," +
  "patricia,patrick,paul,paula,paulette,pauline,pedro,peggy,penelope,perrine,philippe,philomene," +
  "pierre,pierrette,pierrick,priscilla,quentin,rabah,rachel,rachid,rachida,rafael,raissa,ramata," +
  "raoul,raphael,raphaelle,rayan,rayane,raymond,raymonde,rebecca,regine,regis,remi,remy,renaud,rene," +
  "renee,ricardo,richard,rita,robert,roberto,robin,rocco,rodolphe,rodrigue,roger,roland,rolande," +
  "romain,romane,romeo,romuald,romy,rosa,rosalie,rose,roseline,rosine,roxane,ruben,rudy,rui,ryan," +
  "sabah,sabine,sabri,sabrina,sacha,sadio,safia,said,salah,salima,salim,salome,salomon,samantha," +
  "samba,sami,samia,samir,samira,samuel,samy,sandra,sandrine,sandy,sara,sarah,sasha,saskia,sean," +
  "sebastien,sekou,selena,selim,selma,serge,severine,seydou,shana,shirley,sidonie,sylvain,silvia," +
  "simeon,simon,simone,sofia,sofiane,sohan,solal,solange,soline,sonia,sophia,sophie,soraya,souad," +
  "soukaina,stanislas,stella,stephane,stephanie,steve,steven,suzanne,suzie,sven,sybille,sylvette," +
  "sylviane,sylvie,tania,tanguy,tara,tatiana,teddy,teo,teresa,tess,tessa,thais,thea,theo,theodore," +
  "theophile,therese,thibaud,thibault,thibaut,thierno,thierry,thomas,tiago,tidiane,tiffany,timeo," +
  "timothe,timothee,tina,titouan,tom,toma,tony,toussaint,tristan,tyler,ugo,ulysse,valentin," +
  "valentine,valentina,valerie,valery,vanessa,vera,veronique,victoire,victor,victoria,vincent," +
  "violette,virgile,virginie,vivian,viviane,vivien,walid,walter,wandrille,warren,wassim,wendy," +
  "wesley,wilfried,william,willy,wissam,xavier,yacine,yael,yamina,yanis,yann,yannick,yasmina," +
  "yasmine,yassin,yassine,yohan,yohann,youcef,younes,youri,yousra,youssef,youssouf,yvan,yves,yvette," +
  "yvon,yvonne,zacharie,zackary,zahra,zahia,zaid,zakaria,zara,zaynab,zelie,zineb,zinedine,zoe,zohra," +
  // Complément 2026-08 : prénoms manquants relevés à l'usage (CV réels).
  "oussama,osama,oussema,aymane,ayman,aimen,amjad,anass,ilias,ilyass,ismail,othmane,otmane,otman," +
  "hamid,abdelhamid,abdelilah,abdeljalil,abdelmajid,abdelaziz,abderrahim,abderrahmane,abdessamad," +
  "reda,rida,ridha,imad,imade,houssam,houssem,hossam,wael,wail,tarik,tariq,tarek,nawfal,naoufal," +
  "naoufel,jalil,jamal,kamal,majid,mounir,monir,nizar,rachad,salman,slimane,soulaimane,souleymane," +
  "yassir,yasser,zouhair,zohair,adnane,adnan,anouar,anwar,badr,badreddine,bilel,chakib,chouaib," +
  "fouad,ghali,ghassan,hatim,hatem,hichem,ilyas,jaouad,jawad,khalid,khalil,lahcen,lahoucine," +
  "mohcine,mouad,moad,moustapha,mostafa,mustafa,redouane,redouan,saad,saif,salah,salaheddine," +
  "samad,tahar,taha,yahya,yahia,zaki,zakariae,zakarya,haitham,haytham,achraf,ashraf,chadi,fadi," +
  "firas,karam,mazen,rami,ramy,samer,wissem,oumaima,oumayma,salma,chaimae,chayma,doha,douaa,ghita," +
  "hajar,hajer,hafsa,ibtissam,ibtissem,ikram,ikrame,kaoutar,kawtar,khaoula,laila,loubna,majda," +
  "maroua,najat,najwa,nezha,nihal,nihad,nisrine,nissrine,noor,rajae,rania,ranya,safae,sanae,siham," +
  "sihame,wafa,wafae,wiam,wiame,pavel,andrei,sergei,dmitri,mikhail,oleg,viktor,stefan,luka,marko," +
  "aleksandar,bogdan,radu,cristian,ioana,elena,svetlana,natalia,oksana,irina,kateryna,priya,ananya," +
  "arjun,rahul,rohan,aditya,vikram,sanjay,deepak,amit,ankit,nikhil,pooja,neha,kavya,ravi,suresh," +
  "kiran,minh,linh,huong,thanh,duc,hung,mehmet,emre,murat,burak,cem,deniz,ozan,elif,zeynep,merve," +
  "esra,diogo,goncalo,nuno,henrique,mateus"
).split(","));
